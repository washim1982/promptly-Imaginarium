// The textual tool-call protocol.
//
// Gemma on LiteRT-LM has no native function-calling channel, so this uses the
// path Odysseus takes for non-native models: the model writes a fenced block
// whose language tag is the tool name, with JSON arguments in the body:
//
//   ```web_search
//   {"query": "LiteRT-LM release notes"}
//   ```
//
// Ported from Odysseus src/tool_parsing.py (_TOOL_BLOCK_RE, parse_tool_blocks,
// strip_tool_blocks), keeping only the fenced pattern — the only one our model
// is ever instructed to use.

import type { ToolCall } from './types';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * ```tag at a fence start, where the tag is exactly a tool name — `(?![\w-])`
 * stops ```bash_example or ```web_search2 prefix-matching a real tool. Inline
 * JSON on the tag line (```list_dir {"path": "."}) is captured separately.
 */
function blockRe(tags: string[]): RegExp {
  return new RegExp(
    '```(' + tags.map(escapeRe).join('|') + ')(?![\\w-])[ \\t]*([{\\[][^\\n]*?)?[ \\t]*(?=\\r?\\n|```)\\r?\\n?([\\s\\S]*?)```',
    'gi',
  );
}

/**
 * Parse a block body into arguments. Small models are loose with the format, so
 * this is lenient in the ways Odysseus found necessary:
 *   - valid JSON object → used as-is
 *   - a `{"body": {...}}` envelope → unwrapped
 *   - anything else → treated as the tool's primary argument (a bare path for
 *     read_file, a bare command for run_command, a bare query for web_search)
 */
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
      /* fall through to primary-arg handling */
    }
  }
  return primaryArg ? { [primaryArg]: text } : { input: text };
}

// ---- Gemma native tool calls ------------------------------------------------------
//
// Gemma 4 is trained on its own tool-call syntax and uses it even when the
// prompt asks for fenced blocks:
//
//   <|tool_call>call:read_file{"path": "src/util.py"}<tool_call|>
//
// Odysseus parses this as "Pattern 4b". Two differences here: the closing
// token is one ControlTokenFilter strips from the stream, so the call arrives
// unterminated; and args are delimited by a brace-balanced, string-aware scan
// rather than Odysseus's non-greedy `\{[\s\S]*?\}`, which stops at the first
// `}` — wrong for nested JSON or file content that contains code.

const GEMMA_OPEN_RE = /<\|?tool_call\|?>\s*call:([\w.-]+)\s*/gi;

/** Index just past the `{...}` starting at `start`, or -1 while unbalanced. */
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

/** Gemma's arguments: JSON, or its `<|"|>` string delimiters and bare keys. */
function parseGemmaArgs(body: string, primaryArg: string | undefined): Record<string, unknown> {
  const text = body.replace(/<\|"\|>/g, '"').replace(/<\|"/g, '"').replace(/"\|>/g, '"');
  for (const candidate of [text, text.replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* try the next repair */
    }
  }
  return parseArgs(text.replace(/^\{|\}$/g, ''), primaryArg);
}

interface Span {
  start: number;
  end: number; // -1 while the call is still streaming in
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
      // Swallow a closing token if one survived.
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
  // Native calls are unambiguous intent, so any name is accepted: an unknown
  // one gets an "unknown tool, available: …" result the model can correct from.
  for (const s of gemmaSpans(text, primaryArgs)) if (s.call) found.push({ at: s.start, call: s.call });
  return found.sort((a, b) => a.at - b.at).map((f) => f.call);
}

/** Remove complete tool calls — what gets saved as the assistant's prose. */
export function stripToolBlocks(text: string, tags: string[]): string {
  let out = tags.length ? text.replace(blockRe(tags), '') : text;
  const spans = gemmaSpans(out, {}).filter((s) => s.end >= 0);
  for (const s of spans.reverse()) out = out.slice(0, s.start) + out.slice(s.end);
  return out.replace(/\n{3,}/g, '\n\n');
}

/**
 * What to show while a round is still streaming: complete tool blocks removed
 * (they render as step cards instead), and an unclosed trailing tool fence cut
 * off so half a JSON blob never flashes on screen.
 */
export function visibleText(text: string, tags: string[], streaming = true): string {
  let stripped = stripToolBlocks(text, tags);
  // A native call still streaming in (no balanced args yet) is hidden too —
  // and on finished text, an unterminated one is garbage, not prose.
  const partial = gemmaSpans(stripped, {}).find((s) => s.end < 0);
  if (partial) stripped = stripped.slice(0, partial.start).trimEnd();
  if (!tags.length || !streaming) return stripped.trim();
  const open = new RegExp('```(' + tags.map(escapeRe).join('|') + ')(?![\\w-])', 'gi');
  let cut = -1;
  for (const m of stripped.matchAll(open)) cut = m.index ?? cut;
  // Only an *unclosed* fence is cut — there's no ``` after it.
  if (cut >= 0 && !stripped.slice(cut + 3).includes('```')) return stripped.slice(0, cut).trimEnd();
  // Mid-stream only: a trailing backtick run may be a tool fence still
  // arriving. Never applied to finished text, where it would eat the closing
  // fence of a legitimate code example.
  return stripped.replace(/`{1,3}[a-z_]*$/i, '').trimEnd();
}

/** Signature for loop detection: tool plus normalised args, like Odysseus's. */
export function callSignature(call: ToolCall): string {
  return `${call.tool}:${call.raw.replace(/\s+/g, ' ').trim().slice(0, 120)}`;
}
