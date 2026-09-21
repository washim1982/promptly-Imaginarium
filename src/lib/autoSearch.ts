// Deciding when a plain chat message needs the live web.
//
// A local model's knowledge stops at its training cut-off, and it has no way to
// know that. So before answering we look at the user's own words: anything that
// asks about now — today's news, a current price, the latest version — is
// answered better from a search than from memory.
//
// This runs in the renderer with no model call, so it costs nothing and is
// predictable: the same sentence always decides the same way. The cost of a
// wrong "yes" is one extra search; the cost of a wrong "no" is a confidently
// stale answer, so the patterns lean slightly towards searching.

/** "search the web for X", "google X" — the user asked outright. */
const EXPLICIT = /\b(?:search (?:the )?(?:web|online|internet)(?:\s+for)?|look (?:it|this|that)? ?up online|google (?:for )?|check online|web search)\b/i;

/**
 * "don't search", "without searching", "no need to look it up".
 * The verbs carry their -ing forms: "without search" is rare, "without
 * searching" is how people actually write it.
 */
const SUPPRESSED = /\b(?:do ?n['’]?t|do not|no need to|without)\s+(?:search(?:ing|es)?|googl(?:e|ing)|look(?:ing)?\s+(?:it|this|that)\s+up|check(?:ing)?\s+online)\b/i;

/** Time-sensitive language: the answer depends on when it is asked. */
const RECENCY = [
  /\b(?:today|tonight|tomorrow|yesterday|right now|just now|currently|nowadays)\b/i,
  /\b(?:this|last|next|past|coming)\s+(?:week|month|year|quarter|weekend|night|morning|evening)\b/i,
  // "so far" is deliberately absent: "summarise our conversation so far" is
  // about the chat, not about the world.
  /\b(?:latest|newest|most recent|recently|up[- ]to[- ]date|as of now|at the moment)\b/i,
  /\bcurrent(?:ly)?\s+(?:price|version|status|state|ceo|president|champion|leader|rate|value|score)\b/i,
  /\bwho (?:is|are) (?:the )?current\b/i,
  /\b(?:still|now)\s+(?:supported|available|maintained|deprecated|free|open)\b/i,
];

/** Topics whose answers move: news, markets, releases, weather, sport. */
const VOLATILE = [
  /\b(?:news|headlines?|breaking|announced|announcement)\b/i,
  /\b(?:released?|release notes|changelog|new version|latest version|update[ds]?)\b/i,
  /\b(?:price|pricing|cost[s]? (?:now|today)|stock|share price|market cap|exchange rate|inflation)\b/i,
  /\b(?:weather|forecast|temperature outside)\b/i,
  /\b(?:who won|final score|standings|fixtures?|election results?)\b/i,
  /\b(?:is|are)\s+\S+\s+(?:down|offline|outage)\b/i,
];

/** A year at or after the one we are in — asking about now or the future. */
function mentionsCurrentOrFutureYear(text: string, now: Date): boolean {
  const thisYear = now.getFullYear();
  for (const m of text.matchAll(/\b(20\d{2})\b/g)) {
    if (Number(m[1]) >= thisYear) return true;
  }
  return false;
}

export interface AutoSearchDecision {
  search: boolean;
  /** Why, for the log and for explaining the behaviour in Settings. */
  reason: 'explicit' | 'recency' | 'volatile' | 'year' | 'suppressed' | 'not-needed' | 'private';
}

/**
 * Should this message be answered with fresh web results?
 *
 * `hasAttachments` suppresses the automatic case deliberately: an email, a
 * Drive file or a workspace file is private, and the app's rule elsewhere is
 * that private data in the conversation gates anything that leaves the machine.
 * An explicit "search the web for…" still wins, because that is the user
 * asking for it in the same breath.
 */
export function decideAutoSearch(
  text: string,
  opts: { hasAttachments?: boolean; now?: Date } = {},
): AutoSearchDecision {
  const q = text.trim();
  if (!q) return { search: false, reason: 'not-needed' };
  if (SUPPRESSED.test(q)) return { search: false, reason: 'suppressed' };
  if (EXPLICIT.test(q)) return { search: true, reason: 'explicit' };
  if (opts.hasAttachments) return { search: false, reason: 'private' };
  if (RECENCY.some((re) => re.test(q))) return { search: true, reason: 'recency' };
  if (VOLATILE.some((re) => re.test(q))) return { search: true, reason: 'volatile' };
  if (mentionsCurrentOrFutureYear(q, opts.now ?? new Date())) return { search: true, reason: 'year' };
  return { search: false, reason: 'not-needed' };
}

/** The query to send: the user's words, minus the "search the web for" framing. */
export function searchQueryFor(text: string): string {
  // Whitespace is collapsed first: the patterns expect single spaces, so
  // "google   vite 7" would otherwise keep its "google".
  const normalized = text.trim().replace(/\s+/g, ' ');
  return (
    normalized
      .replace(EXPLICIT, ' ')
      .replace(/^[\s,:;]+|[\s,:;]+$/g, '')
      .replace(/\s+/g, ' ')
      .slice(0, 300) || normalized.slice(0, 300)
  );
}
