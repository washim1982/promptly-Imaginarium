
import type { Candidate } from './api';

export const BATCH_SIZE = 8;

export const DEEP_SCAN_SYSTEM = `You are a security reviewer checking whether values found in source code are real credentials.
A credential is a value that grants access: an API key, access token, password, private key, session cookie, or a password inside a connection string.
NOT credentials: public identifiers, URLs without a password, UUIDs used as ids, file hashes and checksums, version numbers, base64 of ordinary text, placeholder or example values, variable names, and test fixtures that are obviously fake.
Answer with one line per item and nothing else, in this exact format:
<number> YES <short kind>
<number> NO
Example:
1 YES api key
2 NO`;

export function buildBatchPrompt(batch: Candidate[]): string {
  const items = batch
    .map((c, i) => `${i + 1}. file: ${c.path} (line ${c.line})\n   code: ${c.snippet}\n   value: ${c.value}`)
    .join('\n');
  return `Decide for each item whether the value is a real credential.\n\n${items}\n\nAnswer ${batch.length} line(s), one per item, in the required format.`;
}

export interface Verdict {
  secret: boolean;
  kind: string;
}

export function parseVerdicts(text: string, batchSize: number): Map<number, Verdict> {
  const out = new Map<number, Verdict>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^[\s>*\-#`]+/, '').trim();
    const match = /^(\d{1,3})\s*[).:|\-–]?\s*(YES|NO)\b[\s:.\-–]*(.*)$/i.exec(line);
    if (!match) continue;
    const index = Number(match[1]);
    if (index < 1 || index > batchSize || out.has(index)) continue;
    const secret = match[2].toUpperCase() === 'YES';
    const kind = match[3]
      .replace(/[`*_"']/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
    out.set(index, { secret, kind: secret ? kind || 'credential' : '' });
  }
  return out;
}

export function maskValue(value: string): string {
  const v = value.replace(/\s+/g, ' ').trim();
  if (v.length <= 8) return `${v.slice(0, 2)}${'•'.repeat(4)}`;
  return `${v.slice(0, 4)}${'•'.repeat(6)}${v.slice(-2)}`;
}
