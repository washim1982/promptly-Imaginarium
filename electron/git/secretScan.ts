// Credential scanner for Git Studio's Scan button.
//
// Looks in two places: the files as they are now (tracked and untracked), and
// every blob that has ever been committed on any branch — a credential deleted
// in a later commit is still in the history, which is the case that matters.
//
// Findings are reported with the value masked. The literal value is kept only
// in the main process, so removing it later can match exactly.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './gitService';

/**
 * Bigger than this and a file is almost certainly not hand-written config.
 * Anything skipped is counted and reported, so a secret is never missed
 * silently — the same limit governs removal (historyRewrite.ts imports it).
 */
export const MAX_BLOB_BYTES = 5_000_000;
const MAX_BLOBS = 20_000;
const MAX_FINDINGS = 500;
/** A line with this marker is skipped — lets this file's own patterns be ignored. */
const IGNORE_MARKER = 'secret-scan:ignore';

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.pdf', '.zip', '.gz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.wasm', '.pak', '.bin', '.node', '.traineddata', '.litertlm',
  '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.mp3', '.wav', '.pyc', '.class', '.jar',
]);

export interface SecretRule {
  id: string;
  label: string;
  /** Must have the global flag; group 1 (if present) is the secret itself. */
  pattern: RegExp;
  /** Cheap check applied to the match before reporting. */
  accept?: (value: string) => boolean;
}

/** Values that look like a placeholder rather than a real credential. */
function looksReal(value: string): boolean {
  const v = value.trim();
  if (v.length < 8) return false;
  if (/^\$?\{|\$\(|process\.env|import\.meta\.env|%[A-Z_]+%|<[^>]+>/.test(v)) return false;
  if (/^(your|my|the)[-_ ]/i.test(v)) return false;
  if (/(example|sample|placeholder|changeme|dummy|test[-_]?value|redacted|removed|xxxx+|\*{3,}|\.{3,})/i.test(v)) return false;
  if (/^[a-z]+$/.test(v) && v.length < 16) return false; // a plain word
  return /[0-9]/.test(v) || /[A-Z]/.test(v) || /[_\-+/=]/.test(v);
}

// The patterns are written so they can't match their own source text here.
export const SECRET_RULES: SecretRule[] = [
  { id: 'aws-access-key', label: 'AWS access key ID', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'aws-secret', label: 'AWS secret access key', pattern: /\baws.{0,20}?(?:secret|private).{0,20}?["']([A-Za-z0-9/+=]{40})["']/gi },
  { id: 'github-token', label: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { id: 'gitlab-token', label: 'GitLab token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'slack-token', label: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'slack-webhook', label: 'Slack webhook URL', pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/+]{20,}/g },
  { id: 'discord-webhook', label: 'Discord webhook URL', pattern: /https:\/\/discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]{20,}/g },
  { id: 'stripe-key', label: 'Stripe secret key', pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { id: 'google-api-key', label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'google-oauth-secret', label: 'Google OAuth client secret', pattern: /\bGOCSPX-[A-Za-z0-9_-]{15,}\b/g },
  { id: 'openai-key', label: 'OpenAI API key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { id: 'anthropic-key', label: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'npm-token', label: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  { id: 'private-key', label: 'Private key block', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { id: 'jwt', label: 'JSON Web Token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    id: 'connection-string',
    label: 'Connection string with a password',
    pattern: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqps?|ftp|ssh):\/\/[^\s:@/"']+:([^\s:@/"']{4,})@/gi,
  },
  {
    id: 'assigned-secret',
    label: 'Password / secret / API key in code',
    // `[A-Za-z_]*` so camelCase names match too: dbPassword, myApiKey, authToken.
    pattern:
      /\b[A-Za-z_]*(?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|private[_-]?key)\b["']?\s*[:=]\s*["']([^"'\s]{8,})["']/gi,
  },
  {
    id: 'env-assignment',
    label: 'Secret in an .env-style assignment',
    pattern: /^[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|APIKEY|API_KEY|PRIVATE_KEY|CLIENT_SECRET)[A-Z0-9_]*=(.{8,})$/gm,
  },
];

export type FindingWhere = 'worktree' | 'history';

export interface Finding {
  id: string;
  rule: string;
  ruleLabel: string;
  where: FindingWhere;
  path: string;
  line: number;
  /** The value with its middle replaced by dots. */
  masked: string;
  /** Short commit that introduced this version of the file (history findings). */
  commit?: string;
  /** Blob the match was found in (history findings). */
  blob?: string;
}

export interface SkippedCounts {
  /** Too large to scan (see MAX_BLOB_BYTES). */
  large: number;
  /** Binary content, or an extension that is never text. */
  binary: number;
}

export interface ScanResult {
  findings: Finding[];
  filesScanned: number;
  blobsScanned: number;
  /** Files/blobs the scan could not look inside. */
  skipped: SkippedCounts;
  /** Set when the scan hit its own limits and stopped early. */
  truncated: boolean;
  /** Distinct secret values found, for the removal step. */
  secretCount: number;
}

export function maskSecret(value: string): string {
  const v = value.replace(/\s+/g, ' ').trim();
  if (v.length <= 8) return `${v.slice(0, 2)}${'•'.repeat(4)}`;
  return `${v.slice(0, 4)}${'•'.repeat(6)}${v.slice(-2)}`;
}

const isBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);
const skipPath = (p: string) => BINARY_EXT.has(path.extname(p).toLowerCase());

/**
 * Every match in one file's text. `secrets` collects finding id → literal
 * value; it stays in the main process so removal can match exactly.
 */
export function scanText(
  text: string,
  where: FindingWhere,
  filePath: string,
  secrets: Map<string, string>,
  extra: { commit?: string; blob?: string } = {},
): Finding[] {
  const found: Finding[] = [];
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (index: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  for (const rule of SECRET_RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      const value = (match[1] ?? match[0]).trim();
      if (!looksReal(value) || (rule.accept && !rule.accept(value))) continue;
      const lineIndex = lineOf(match.index ?? 0);
      const lineText = text.slice(lineStarts[lineIndex], lineStarts[lineIndex + 1] ?? text.length);
      if (lineText.includes(IGNORE_MARKER)) continue;
      const id = `${where}:${extra.blob ?? filePath}:${lineIndex + 1}:${rule.id}:${found.length}`;
      secrets.set(id, value); // literal value, main process only
      found.push({
        id,
        rule: rule.id,
        ruleLabel: rule.label,
        where,
        path: filePath,
        line: lineIndex + 1,
        masked: maskSecret(value),
        ...extra,
      });
      if (found.length >= MAX_FINDINGS) return found;
    }
  }
  return found;
}

// ---- deep scan candidates ------------------------------------------------------------
//
// The pattern rules only find shapes they know. For the optional AI pass, this
// picks out lines that *could* hold a secret — a long, random-looking value, or
// any value assigned to a secret-sounding name — and the local model decides.
// Cheap, deterministic pre-filtering keeps the model's work small.

const SECRET_WORDS =
  /\b(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|apikey|auth|credential|private[_-]?key|access[_-]?key|session|cookie|signature|salt|cert)\b/i;

/**
 * "dbPassword" → "db Password", "SESSION_SECRET" → "SESSION SECRET". Both
 * camel humps and underscores hide the word from \b, and identifiers are
 * written both ways.
 */
const splitIdentifiers = (text: string) => text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_+/g, ' ');
const hasSecretWord = (line: string) => SECRET_WORDS.test(splitIdentifiers(line));
/** Values that are obviously not credentials even though they look random. */
const NOT_SECRET = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$|^\d+(?:\.\d+)*$|^#[0-9a-fA-F]{3,8}$|^(?:https?|file):\/\/[^\s"']*$/;
const MAX_CANDIDATES = 200;

/** Shannon entropy per character — high means "looks random". */
export function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

export interface Candidate {
  id: string;
  path: string;
  line: number;
  where: FindingWhere;
  commit?: string;
  /** The line, trimmed and capped — what the model is shown. */
  snippet: string;
  /** The value itself, so a confirmed candidate can be removed. */
  value: string;
}

const VALUE_RE = /["'`]([^"'`\s]{10,200})["'`]|[:=]\s*([A-Za-z0-9_\-./+=]{16,200})\s*$|\b([A-Za-z0-9_\-]{24,200})\b/g;

/** Suspicious values on one line, ignoring anything the rules already found. */
export function candidateValues(line: string, known: Set<string>): string[] {
  const keyed = hasSecretWord(line);
  const out: string[] = [];
  VALUE_RE.lastIndex = 0;
  for (const m of line.matchAll(VALUE_RE)) {
    const value = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!value || known.has(value) || out.includes(value)) continue;
    if (value.length < 10 || value.length > 200) continue;
    if (NOT_SECRET.test(value) || !looksReal(value)) continue;
    const bits = entropy(value);
    // A secret-sounding name lowers the bar; otherwise the value must look random.
    if (keyed ? bits >= 2.2 : bits >= 3.6 && value.length >= 20) out.push(value);
  }
  return out;
}

const nul = (raw: string) => raw.split('\0').filter(Boolean);

interface TextUnit {
  text: string;
  path: string;
  where: FindingWhere;
  blob?: string;
}

interface WalkTotals {
  filesScanned: number;
  blobsScanned: number;
  skipped: SkippedCounts;
  truncated: boolean;
}

/**
 * Every readable text in the repository: the working tree (tracked and
 * untracked, respecting .gitignore) and every blob on every ref. `onText`
 * returns false to stop early. Shared by the rule scan and the AI pre-filter.
 */
async function walkTexts(root: string, onText: (unit: TextUnit) => boolean | Promise<boolean>): Promise<WalkTotals> {
  const totals: WalkTotals = { filesScanned: 0, blobsScanned: 0, skipped: { large: 0, binary: 0 }, truncated: false };

  const [tracked, untracked] = await Promise.all([
    runGit(['ls-files', '-z'], root),
    runGit(['ls-files', '-z', '--others', '--exclude-standard'], root),
  ]);
  const allFiles = [...new Set([...nul(tracked), ...nul(untracked)])];
  const files = allFiles.filter((f) => !skipPath(f));
  totals.skipped.binary += allFiles.length - files.length;
  for (const rel of files) {
    const abs = path.join(root, rel);
    const st = await stat(abs).catch(() => null);
    if (!st?.isFile()) continue;
    if (st.size > MAX_BLOB_BYTES) {
      totals.skipped.large++;
      continue;
    }
    const buf = await readFile(abs).catch(() => null);
    if (!buf || isBinary(buf)) {
      totals.skipped.binary++;
      continue;
    }
    totals.filesScanned++;
    if ((await onText({ text: buf.toString('utf8'), path: rel, where: 'worktree' })) === false) {
      totals.truncated = true;
      return totals;
    }
  }

  // `rev-list --objects` lists each object once, with the path it was seen at.
  const objects = (await runGit(['rev-list', '--objects', '--all'], root)).split(/\r?\n/);
  const blobs: { sha: string; path: string }[] = [];
  const seen = new Set<string>();
  for (const line of objects) {
    const space = line.indexOf(' ');
    if (space < 0) continue; // commits and trees have no path
    const sha = line.slice(0, space);
    const p = line.slice(space + 1);
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (!p || skipPath(p)) {
      totals.skipped.binary++;
      continue;
    }
    blobs.push({ sha, path: p });
  }
  if (blobs.length > MAX_BLOBS) totals.truncated = true;

  for (const { sha, path: p } of blobs.slice(0, MAX_BLOBS)) {
    const meta = await runGit(['cat-file', '-s', sha], root).catch(() => '');
    if (!meta) continue;
    if (Number(meta.trim()) > MAX_BLOB_BYTES) {
      totals.skipped.large++;
      continue;
    }
    const content = await runGit(['cat-file', 'blob', sha], root).catch(() => '');
    if (!content) continue;
    if (content.includes('\0')) {
      totals.skipped.binary++;
      continue;
    }
    totals.blobsScanned++;
    if ((await onText({ text: content, path: p, where: 'history', blob: sha })) === false) {
      totals.truncated = true;
      return totals;
    }
  }
  return totals;
}

/** Short hash of the commit that introduced a blob — enough to point at it. */
async function introducedBy(root: string, sha: string): Promise<string | undefined> {
  const out = (await runGit(['log', '--all', '--format=%h', '-1', `--find-object=${sha}`], root).catch(() => '')).trim();
  return out.split(/\r?\n/)[0] || undefined;
}

/**
 * Scan the working tree and the whole history with the rules.
 *
 * `secrets` comes back holding the literal values (never sent to the renderer)
 * so removeSecrets() can match them exactly.
 */
export async function scanRepository(root: string): Promise<ScanResult & { secrets: Map<string, string> }> {
  const secrets = new Map<string, string>();
  const findings: Finding[] = [];

  const totals = await walkTexts(root, async ({ text, path: p, where, blob }) => {
    const hits = scanText(text, where, p, secrets, blob ? { blob } : {});
    if (hits.length && blob) {
      const commit = await introducedBy(root, blob);
      for (const hit of hits) hit.commit = commit;
    }
    findings.push(...hits);
    return findings.length < MAX_FINDINGS;
  });

  // A value present in the working tree and in history is one secret, two findings.
  const distinct = new Set(secrets.values()).size;
  return {
    findings,
    filesScanned: totals.filesScanned,
    blobsScanned: totals.blobsScanned,
    skipped: totals.skipped,
    truncated: totals.truncated,
    secretCount: distinct,
    secrets,
  };
}

/**
 * Lines the rules didn't match but that could still hold a credential, for the
 * optional AI pass. Returns at most MAX_CANDIDATES, deduplicated by value, with
 * secret-sounding lines first so the cap keeps the most likely ones.
 */
export async function collectCandidates(
  root: string,
  known: Set<string>,
): Promise<{ candidates: Candidate[]; linesConsidered: number; truncated: boolean }> {
  const byValue = new Map<string, Candidate & { keyed: boolean }>();
  let linesConsidered = 0;

  const totals = await walkTexts(root, async ({ text, path: p, where, blob }) => {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 600 || line.includes(IGNORE_MARKER)) continue;
      const values = candidateValues(line, known);
      if (!values.length) continue;
      linesConsidered++;
      for (const value of values) {
        if (byValue.has(value)) continue;
        byValue.set(value, {
          id: `ai:${where}:${blob ?? p}:${i + 1}:${byValue.size}`,
          path: p,
          line: i + 1,
          where,
          snippet: line.trim().slice(0, 240),
          value,
          keyed: hasSecretWord(line),
          ...(blob ? { commit: undefined } : {}),
        });
      }
    }
    return byValue.size < MAX_CANDIDATES * 3;
  });

  const ranked = [...byValue.values()].sort((a, b) => Number(b.keyed) - Number(a.keyed) || b.value.length - a.value.length);
  const candidates = ranked.slice(0, MAX_CANDIDATES).map(({ keyed: _keyed, ...c }) => c);
  // Only for the few that are kept: which commit they came from.
  for (const c of candidates) {
    if (c.where === 'history') {
      const blob = c.id.split(':')[2];
      c.commit = await introducedBy(root, blob);
    }
  }
  return { candidates, linesConsidered, truncated: totals.truncated || ranked.length > MAX_CANDIDATES };
}
