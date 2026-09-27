
const EXPLICIT = /\b(?:search (?:the )?(?:web|online|internet)(?:\s+for)?|look (?:it|this|that)? ?up online|google (?:for )?|check online|web search)\b/i;

const SUPPRESSED = /\b(?:do ?n['’]?t|do not|no need to|without)\s+(?:search(?:ing|es)?|googl(?:e|ing)|look(?:ing)?\s+(?:it|this|that)\s+up|check(?:ing)?\s+online)\b/i;

const RECENCY = [
  /\b(?:today|tonight|tomorrow|yesterday|right now|just now|currently|nowadays)\b/i,
  /\b(?:this|last|next|past|coming)\s+(?:week|month|year|quarter|weekend|night|morning|evening)\b/i,
  /\b(?:latest|newest|most recent|recently|up[- ]to[- ]date|as of now|at the moment)\b/i,
  /\bcurrent(?:ly)?\s+(?:price|version|status|state|ceo|president|champion|leader|rate|value|score)\b/i,
  /\bwho (?:is|are) (?:the )?current\b/i,
  /\b(?:still|now)\s+(?:supported|available|maintained|deprecated|free|open)\b/i,
];

const VOLATILE = [
  /\b(?:news|headlines?|breaking|announced|announcement)\b/i,
  /\b(?:released?|release notes|changelog|new version|latest version|update[ds]?)\b/i,
  /\b(?:price|pricing|cost[s]? (?:now|today)|stock|share price|market cap|exchange rate|inflation)\b/i,
  /\b(?:weather|forecast|temperature outside)\b/i,
  /\b(?:who won|final score|standings|fixtures?|election results?)\b/i,
  /\b(?:is|are)\s+\S+\s+(?:down|offline|outage)\b/i,
];

function mentionsCurrentOrFutureYear(text: string, now: Date): boolean {
  const thisYear = now.getFullYear();
  for (const m of text.matchAll(/\b(20\d{2})\b/g)) {
    if (Number(m[1]) >= thisYear) return true;
  }
  return false;
}

export interface AutoSearchDecision {
  search: boolean;
  reason: 'explicit' | 'recency' | 'volatile' | 'year' | 'suppressed' | 'not-needed' | 'private';
}

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

export function searchQueryFor(text: string): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  return (
    normalized
      .replace(EXPLICIT, ' ')
      .replace(/^[\s,:;]+|[\s,:;]+$/g, '')
      .replace(/\s+/g, ' ')
      .slice(0, 300) || normalized.slice(0, 300)
  );
}
