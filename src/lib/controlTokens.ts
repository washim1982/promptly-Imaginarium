
const CONTROL_TOKENS = [
  '<image|>',
  '<audio|>',
  '<tool|>',
  '<tool_call|>',
  '<tool_response|>',
  '<channel|>',
  '<turn|>',
  '<bos>',
  '<eos>',
  '<pad>',
  '<unk>',
  '<mask>',
] as const;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ALTERNATION = CONTROL_TOKENS.map(escape).join('|');
const RUN_RE = new RegExp(`(?:${ALTERNATION})+`, 'g');

const MAX_TOKEN_LEN = Math.max(...CONTROL_TOKENS.map((t) => t.length));

const MARKDOWN_DELIMITER = /[*_~`]/;

function needsSpace(before: string, after: string): boolean {
  if (!before || !after) return false;
  if (/\s/.test(before) || /\s/.test(after)) return false;
  if (MARKDOWN_DELIMITER.test(before) || MARKDOWN_DELIMITER.test(after)) return false;
  if (/[([{]/.test(before)) return false;
  if (/[)\]},.;:!?([]/.test(after)) return false;
  return true;
}

function collapse(text: string, lastChar: string): string {
  return text.replace(RUN_RE, (match: string, offset: number) => {
    const before = offset > 0 ? text[offset - 1] : lastChar;
    const after = text[offset + match.length] ?? '';
    return needsSpace(before, after) ? ' ' : '';
  });
}

export function stripControlTokens(text: string): string {
  return collapse(text, '');
}

export class ControlTokenFilter {
  private pending = '';
  private lastChar = '';

  push(chunk: string): string {
    const buffer = this.pending + chunk;
    const cut = undecidedFrom(buffer);
    this.pending = buffer.slice(cut);

    const out = collapse(buffer.slice(0, cut), this.lastChar);
    if (out) this.lastChar = out[out.length - 1];
    return out;
  }

  flush(): string {
    const out = collapse(this.pending, this.lastChar);
    this.pending = '';
    this.lastChar = '';
    return out;
  }
}

function undecidedFrom(buffer: string): number {
  let end = buffer.length;

  for (;;) {
    const token = CONTROL_TOKENS.find((t) => buffer.endsWith(t, end));
    if (!token) break;
    end -= token.length;
  }
  if (end === 0) return 0;

  const lastOpen = buffer.lastIndexOf('<', end - 1);
  const tooFarBack = lastOpen < end - (MAX_TOKEN_LEN - 1);
  if (lastOpen < 0 || tooFarBack) return end;
  if (buffer.slice(lastOpen, end).includes('>')) return end;
  return lastOpen;
}
