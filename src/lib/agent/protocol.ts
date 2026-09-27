
import type { ToolCall } from './types';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function blockRe(tags: string[]): RegExp {
  return new RegExp(
    '```(' + tags.map(escapeRe).join('|') + ')(?![\\w-])[ \\t]*([{\\[][^\\n]*?)?[ \\t]*(?=\\r?\\n|```)\\r?\\n?([\\s\\S]*?)```',
    'gi',
  );
}

export function parseArgs(body: string, primaryArg: string | undefined): Record<string, unknown> {
  const text = body.trim();
  if (!text) return {};
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        if (Object.keys(obj).length === 1 && obj.body && typeof obj.body === 'object') {
          return obj.body as Record<string, unknown>;
        }
        return obj;
      }
    } catch {
    }
  }
  return primaryArg ? { [primaryArg]: text } : { input: text };
}


const GEMMA_OPEN_RE = /<\|?tool_call\|?>\s*call:([\w.-]+)\s*/gi;

function scanObject(text: string, start: number): number {
  if (text[start] !== '{') return -1;
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"') quote = ch;
    else if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

function parseGemmaArgs(body: string, primaryArg: string | undefined): Record<string, unknown> {
  const text = body.replace(/<\|"\|>/g, '"').replace(/<\|"/g, '"').replace(/"\|>/g, '"');
  for (const candidate of [text, text.replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
    }
  }
  return parseArgs(text.replace(/^\{|\}$/g, ''), primaryArg);
}

interface Span {
  start: number;
  end: number;
  call?: ToolCall;
}

function gemmaSpans(text: string, primaryArgs: Record<string, string | undefined>): Span[] {
  const spans: Span[] = [];
  for (const m of text.matchAll(GEMMA_OPEN_RE)) {
    const start = m.index ?? 0;
    const argsAt = start + m[0].length;
    const tool = m[1].toLowerCase().replace(/-/g, '_');
    let end = text[argsAt] === '{' ? scanObject(text, argsAt) : -1;
    if (end >= 0) {
      const raw = text.slice(argsAt, end);
      const close = /^\s*<\|?tool_call\|?>/.exec(text.slice(end));
      if (close) end += close[0].length;
      spans.push({ start, end, call: { tool, raw, args: parseGemmaArgs(raw, primaryArgs[tool]) } });
    } else {
      spans.push({ start, end: -1 });
    }
  }
  return spans;
}

export function parseToolBlocks(
  text: string,
  tags: string[],
  primaryArgs: Record<string, string | undefined> = {},
): ToolCall[] {
  const found: { at: number; call: ToolCall }[] = [];
  if (tags.length) {
    for (const m of text.matchAll(blockRe(tags))) {
      const tool = m[1].toLowerCase();
      const inline = m[2]?.trim() ?? '';
      const body = (m[3] ?? '').trim();
      const raw = inline && !body ? inline : body || inline;
      found.push({ at: m.index ?? 0, call: { tool, raw, args: parseArgs(raw, primaryArgs[tool]) } });
    }
  }
  for (const s of gemmaSpans(text, primaryArgs)) if (s.call) found.push({ at: s.start, call: s.call });
  return found.sort((a, b) => a.at - b.at).map((f) => f.call);
}

export function stripToolBlocks(text: string, tags: string[]): string {
  let out = tags.length ? text.replace(blockRe(tags), '') : text;
  const spans = gemmaSpans(out, {}).filter((s) => s.end >= 0);
  for (const s of spans.reverse()) out = out.slice(0, s.start) + out.slice(s.end);
  return out.replace(/\n{3,}/g, '\n\n');
}

export function visibleText(text: string, tags: string[], streaming = true): string {
  let stripped = stripToolBlocks(text, tags);
  const partial = gemmaSpans(stripped, {}).find((s) => s.end < 0);
  if (partial) stripped = stripped.slice(0, partial.start).trimEnd();
  if (!tags.length || !streaming) return stripped.trim();
  const open = new RegExp('```(' + tags.map(escapeRe).join('|') + ')(?![\\w-])', 'gi');
  let cut = -1;
  for (const m of stripped.matchAll(open)) cut = m.index ?? cut;
  if (cut >= 0 && !stripped.slice(cut + 3).includes('```')) return stripped.slice(0, cut).trimEnd();
  return stripped.replace(/`{1,3}[a-z_]*$/i, '').trimEnd();
}

export function callSignature(call: ToolCall): string {
  return `${call.tool}:${call.raw.replace(/\s+/g, ' ').trim().slice(0, 120)}`;
}
