// Control-token filtering for decoded model output.
//
// Gemma 4's vocabulary uses a `<name|>` convention for control tokens. The
// LiteRT-LM WASM runtime decodes some of them into the text stream instead of
// suppressing them — most visibly `<image|>`, scattered through otherwise-normal
// prose and code. There is no "skip special tokens" switch on the runtime
// (`stopTokenIds` only ends generation), so the chat layer has to drop them.
//
// IMPORTANT: only unambiguous sentinels belong here. The same vocabulary also
// contains ordinary HTML-shaped pieces — `<div>`, `<table>`, `<img>`, `<h1>`,
// `<code>` … — and `<0xNN>` byte fallbacks. Those are legitimate output; filter
// them and any generated HTML or non-ASCII text gets mangled. The `|>` suffix is
// what makes the control tokens safe to match.

const CONTROL_TOKENS = [
  // `<name|>` control tokens, read out of the model's own vocabulary.
  '<image|>',
  '<audio|>',
  '<tool|>',
  '<tool_call|>',
  '<tool_response|>',
  '<channel|>',
  '<turn|>',
  // Classic sentinels. Never meaningful in a chat transcript.
  '<bos>',
  '<eos>',
  '<pad>',
  '<unk>',
  '<mask>',
] as const;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ALTERNATION = CONTROL_TOKENS.map(escape).join('|');
/** One or more adjacent control tokens, collapsed as a single decision. */
const RUN_RE = new RegExp(`(?:${ALTERNATION})+`, 'g');

const MAX_TOKEN_LEN = Math.max(...CONTROL_TOKENS.map((t) => t.length));

// Markdown delimiters have to touch the text they wrap. `**Update**` is bold,
// `** Update**` is literal asterisks — CommonMark will not open emphasis when the
// delimiter run is followed by whitespace, nor close it when preceded by one. The
// same goes for `_`, `~~` and backticks. Since the model happily emits control
// tokens right after an opening `**`, inserting a space there silently destroys
// the formatting of the reply.
const MARKDOWN_DELIMITER = /[*_~`]/;

/**
 * Should a removed run of control tokens leave a space behind?
 *
 * The tokens are emitted where a word boundary sometimes was and sometimes
 * wasn't, and the original is not recoverable — `a<image|>simple` wants a space,
 * `num_<image|>terms` does not, and the two are structurally identical. These
 * rules get the common cases right.
 */
function needsSpace(before: string, after: string): boolean {
  if (!before || !after) return false; // start or end of the message
  if (/\s/.test(before) || /\s/.test(after)) return false; // already separated
  // Covers both markdown emphasis and snake_case identifiers.
  if (MARKDOWN_DELIMITER.test(before) || MARKDOWN_DELIMITER.test(after)) return false;
  if (/[([{]/.test(before)) return false; // just inside an opening bracket
  if (/[)\]},.;:!?([]/.test(after)) return false; // punctuation binds tight
  return true;
}

function collapse(text: string, lastChar: string): string {
  return text.replace(RUN_RE, (match: string, offset: number) => {
    const before = offset > 0 ? text[offset - 1] : lastChar;
    const after = text[offset + match.length] ?? '';
    return needsSpace(before, after) ? ' ' : '';
  });
}

/** Remove control tokens from a complete string. */
export function stripControlTokens(text: string): string {
  return collapse(text, '');
}

/**
 * Streaming version. Tokens arrive in arbitrary chunks, so `<image|>` can be
 * split across two reads ("…<ima" then "ge|>…"); a naive per-chunk replace would
 * miss those and leak the halves into the UI. Deciding the spacing also needs
 * the character *after* a run, so a run sitting at the end of a chunk is held
 * back until the next one arrives.
 */
export class ControlTokenFilter {
  private pending = '';
  /** Last character already emitted — the "before" context for a run at index 0. */
  private lastChar = '';

  /** Feed a decoded chunk; returns the text that is safe to display now. */
  push(chunk: string): string {
    const buffer = this.pending + chunk;
    const cut = undecidedFrom(buffer);
    this.pending = buffer.slice(cut);

    const out = collapse(buffer.slice(0, cut), this.lastChar);
    if (out) this.lastChar = out[out.length - 1];
    return out;
  }

  /** Release whatever was held back. Call once the stream is done. */
  flush(): string {
    const out = collapse(this.pending, this.lastChar);
    this.pending = '';
    this.lastChar = '';
    return out;
  }
}

/**
 * Index from which `buffer` cannot be decided yet: the start of a trailing run
 * of control tokens (whose spacing depends on the next character), including any
 * partial token that may still be completing.
 */
function undecidedFrom(buffer: string): number {
  let end = buffer.length;

  // Walk back over whole control tokens sitting at the end.
  for (;;) {
    const token = CONTROL_TOKENS.find((t) => buffer.endsWith(t, end));
    if (!token) break;
    end -= token.length;
  }
  if (end === 0) return 0;

  // A control token can only start at '<', so the only other risky tail is a
  // '<' near the end with nothing closing it yet.
  const lastOpen = buffer.lastIndexOf('<', end - 1);
  const tooFarBack = lastOpen < end - (MAX_TOKEN_LEN - 1);
  if (lastOpen < 0 || tooFarBack) return end;
  // Already closed, so it is a finished tag (e.g. "<div>"), not a fragment.
  if (buffer.slice(lastOpen, end).includes('>')) return end;
  return lastOpen;
}
