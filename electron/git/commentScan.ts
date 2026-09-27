
import ts from 'typescript';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './gitService';

const MAX_FILE_BYTES = 5_000_000;
const MAX_FINDINGS = 4000;

const TS_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const CSS_EXT = new Set(['.css', '.scss', '.less']);

export type CommentKind =
  | 'directive'
  | 'license'
  | 'sensitive'
  | 'dead-code'
  | 'task'
  | 'doc'
  | 'prose';

export interface CommentFinding {
  id: string;
  file: string;
  line: number;
  kind: CommentKind;
  locked: boolean;
  preview: string;
  lines: number;
  chars: number;
  detail?: string;
}

export interface CommentScanResult {
  findings: CommentFinding[];
  filesScanned: number;
  filesWithComments: number;
  totalComments: number;
  totalChars: number;
  sourceChars: number;
  skipped: { unsupported: number; large: number; unreadable: number; minified: number };
  truncated: boolean;
}

const DIRECTIVE =
  /^\s*[/*\s]*(?:eslint-|@eslint|ts-|@ts-|prettier-|biome-|oxlint-|istanbul |c8 |v8 |webpack|@vite|vite-|#region|#endregion|#!|<reference|jsx |jsxImportSource|use strict|global |secret-scan:ignore|@jest|@vitest|noinspection)/i;

const LICENSE = /copyright|\(c\)\s*\d{4}|spdx-license|@license|@preserve|all rights reserved/i;
const TASK = /\b(?:TODO|FIXME|HACK|XXX|BUG|WIP)\b[:( ]/;

const SENSITIVE: { label: string; re: RegExp }[] = [
  { label: 'Local machine path', re: /[A-Za-z]:\\[\\\w .-]{3,}|\/(?:home|Users)\/[\w.-]+\// },
  { label: 'Path to another project on disk', re: /\.\.[\\/](?:workspace|research|chatgpt|projects|dev|code)[\\/][\w.-]+/i },
  { label: 'Private IP or internal hostname', re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|[\w-]+\.(?:corp|internal|intranet|lan)\b)/i },
  { label: 'Machine name', re: /\b[\w-]+-(?:pc|laptop|desktop|workstation)\b/i },
  { label: 'Ticket reference', re: /\b[A-Z]{2,10}-\d{2,6}\b/ },
  {
    label: 'Email address',
    re: /(?<![\w@/.-])[\w.+-]+@(?!example\.|test\.|localhost)[\w-]+\.[a-z]{2,}(?![\w.-]*\d)/i,
  },
];

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

function commentBody(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:\/\/+|\/\*+|\*+\/|\*+)\s?/, '').replace(/\*\/\s*$/, '').trim())
    .filter(Boolean)
    .join('\n');
}

export function looksLikeCode(body: string): boolean {
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return false;
  let code = 0;
  for (const l of lines) {
    if (
      /[;{}]$/.test(l) ||
      /^(?:const|let|var|function|class|import|export|return|if|else|for|while|switch|case|try|catch|await|async|throw)\b/.test(l) ||
      /^[\w.$[\]]+\([^)]*\)\s*;?$/.test(l) ||
      /^[\w.$'"[\]]+\s*[:=]\s*\S.*[,;]?$/.test(l) ||
      /^<\/?[A-Za-z]/.test(l)
    ) {
      code++;
    }
  }
  return code / lines.length >= 0.6;
}

export function classify(text: string, startsFile: boolean): { kind: CommentKind; locked: boolean; detail?: string } {
  if (DIRECTIVE.test(text)) return { kind: 'directive', locked: true };
  const body = commentBody(text);
  if (LICENSE.test(body) && startsFile) return { kind: 'license', locked: true };
  for (const rule of SENSITIVE) {
    const m = rule.re.exec(body);
    if (m) return { kind: 'sensitive', locked: false, detail: `${rule.label}: ${m[0].slice(0, 60)}` };
  }
  if (TASK.test(body)) return { kind: 'task', locked: false };
  if (looksLikeCode(body)) return { kind: 'dead-code', locked: false };
  if (text.startsWith('/**')) return { kind: 'doc', locked: false };
  return { kind: 'prose', locked: false };
}


interface Span {
  start: number;
  end: number;
  text: string;
}

function scanTsComments(text: string, fileName: string): Span[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.Unknown);
  const literals: { start: number; end: number }[] = [];
  const visit = (node: ts.Node): void => {
    switch (node.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateExpression:
      case ts.SyntaxKind.RegularExpressionLiteral:
      case ts.SyntaxKind.JsxText:
        literals.push({ start: node.getStart(source), end: node.getEnd() });
        return;
      default:
        node.forEachChild(visit);
    }
  };
  visit(source);

  const found = new Map<number, Span>();
  const add = (ranges: readonly ts.CommentRange[] | undefined) => {
    for (const r of ranges ?? []) {
      if (found.has(r.pos)) continue;
      const body = text.slice(r.pos, r.end);
      if (!body.startsWith('//') && !body.startsWith('/*')) continue;
      if (literals.some((l) => r.pos < l.end && r.end > l.start)) continue;
      found.set(r.pos, { start: r.pos, end: r.end, text: body });
    }
  };

  const walk = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.JsxText) return;
    add(ts.getLeadingCommentRanges(text, node.getFullStart()));
    add(ts.getTrailingCommentRanges(text, node.getEnd()));
    for (const child of node.getChildren(source)) walk(child);
  };
  walk(source);

  return [...found.values()].sort((a, b) => a.start - b.start);
}

function scanCssComments(text: string): Span[] {
  const spans: Span[] = [];
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close < 0 ? text.length : close + 2;
      spans.push({ start: i, end, text: text.slice(i, end) });
      i = end - 1;
    }
  }
  return spans;
}

const VENDORED = /(?:^|\/)(?:public|vendor|vendored|third_party|thirdparty|externals|assets\/lib)\//i;
const MINIFIED_NAME = /\.min\.(?:js|css)$/i;

function looksMinified(text: string): boolean {
  const lines = text.split('\n');
  if (lines.length < 3) return text.length > 2000;
  return text.length / lines.length > 400;
}

const scannerFor = (file: string): ((text: string, fileName: string) => Span[]) | null => {
  if (VENDORED.test(file.replace(/\\/g, '/')) || MINIFIED_NAME.test(file)) return null;
  const ext = path.extname(file).toLowerCase();
  if (TS_EXT.has(ext)) return scanTsComments;
  if (CSS_EXT.has(ext)) return (text) => scanCssComments(text);
  return null;
};

const nul = (raw: string) => raw.split('\0').filter(Boolean);

interface RecordedSpan {
  file: string;
  start: number;
  end: number;
  text: string;
  locked: boolean;
}

let lastScan: { root: string; spans: Map<string, RecordedSpan> } | null = null;

export async function scanComments(root: string): Promise<CommentScanResult> {
  const findings: CommentFinding[] = [];
  const spans = new Map<string, RecordedSpan>();
  const skipped = { unsupported: 0, large: 0, unreadable: 0, minified: 0 };
  let filesScanned = 0;
  let filesWithComments = 0;
  let totalChars = 0;
  let sourceChars = 0;
  let truncated = false;

  const [tracked, untracked] = await Promise.all([
    runGit(['ls-files', '-z'], root),
    runGit(['ls-files', '-z', '--others', '--exclude-standard'], root),
  ]);

  for (const rel of [...new Set([...nul(tracked), ...nul(untracked)])]) {
    const scan = scannerFor(rel);
    if (!scan) {
      skipped.unsupported++;
      continue;
    }
    const abs = path.join(root, rel);
    const st = await stat(abs).catch(() => null);
    if (!st?.isFile()) continue;
    if (st.size > MAX_FILE_BYTES) {
      skipped.large++;
      continue;
    }
    const text = await readFile(abs, 'utf8').catch(() => null);
    if (text === null) {
      skipped.unreadable++;
      continue;
    }
    if (looksMinified(text)) {
      skipped.minified++;
      continue;
    }
    filesScanned++;
    sourceChars += text.length;

    const found = scan(text, rel);
    if (found.length) filesWithComments++;
    for (const span of found) {
      if (findings.length >= MAX_FINDINGS) {
        truncated = true;
        break;
      }
      const id = `${rel}:${span.start}`;
      const before = text.slice(0, span.start);
      const { kind, locked, detail } = classify(span.text, before.trim().length === 0);
      findings.push({
        id,
        file: rel,
        line: before.split('\n').length,
        kind,
        locked,
        preview: collapse(span.text).slice(0, 160),
        lines: span.text.split('\n').length,
        chars: span.text.length,
        ...(detail ? { detail } : {}),
      });
      spans.set(id, { file: rel, start: span.start, end: span.end, text: span.text, locked });
      totalChars += span.text.length;
    }
    if (truncated) break;
  }

  lastScan = { root, spans };
  return {
    findings,
    filesScanned,
    filesWithComments,
    totalComments: findings.length,
    totalChars,
    sourceChars,
    skipped,
    truncated,
  };
}


export interface RemovalResult {
  filesChanged: string[];
  removed: number;
  stale: number;
  refused: number;
  linesRemoved: number;
}

function cut(text: string, start: number, end: number): { next: string; lines: number } {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const nextNewline = text.indexOf('\n', end);
  const lineEnd = nextNewline < 0 ? text.length : nextNewline;
  const before = text.slice(lineStart, start);
  const after = text.slice(end, lineEnd);
  const removedLines = text.slice(start, end).split('\n').length;

  if (!before.trim() && !after.trim()) {
    const dropTo = nextNewline < 0 ? text.length : nextNewline + 1;
    return { next: text.slice(0, lineStart) + text.slice(dropTo), lines: removedLines };
  }
  if (before.trim() && !after.trim()) {
    return { next: text.slice(0, start).replace(/[ \t]+$/, '') + text.slice(lineEnd), lines: removedLines - 1 };
  }
  return { next: text.slice(0, start) + text.slice(end), lines: 0 };
}

export async function removeComments(root: string, ids: string[]): Promise<RemovalResult> {
  if (!lastScan || lastScan.root !== root) {
    throw new Error('Scan the repository again before removing anything.');
  }
  const byFile = new Map<string, RecordedSpan[]>();
  let refused = 0;
  for (const id of ids) {
    const span = lastScan.spans.get(id);
    if (!span) continue;
    if (span.locked) {
      refused++;
      continue;
    }
    const list = byFile.get(span.file) ?? [];
    list.push(span);
    byFile.set(span.file, list);
  }

  const filesChanged: string[] = [];
  let removed = 0;
  let stale = 0;
  let linesRemoved = 0;

  for (const [file, list] of byFile) {
    const abs = path.join(root, file);
    let text = await readFile(abs, 'utf8').catch(() => null);
    if (text === null) {
      stale += list.length;
      continue;
    }
    list.sort((a, b) => b.start - a.start);
    let changed = false;
    for (const span of list) {
      if (text.slice(span.start, span.end) !== span.text) {
        stale++;
        continue;
      }
      const result = cut(text, span.start, span.end);
      text = result.next;
      linesRemoved += result.lines;
      removed++;
      changed = true;
    }
    if (changed) {
      await writeFile(abs, text, 'utf8');
      filesChanged.push(file);
    }
  }

  lastScan = null;
  return { filesChanged, removed, stale, refused, linesRemoved };
}
