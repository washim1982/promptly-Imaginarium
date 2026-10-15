// Spotting a reply that has collapsed into token salad.
//
// A local model whose prompt or KV cache has gone wrong does not fail — it
// keeps emitting tokens, drawn from the whole vocabulary at once, so the text
// reads as fragments of every script on earth. That is worse than an error,
// because it looks like an answer.
//
// Judged relative to the document: an answer about an English spreadsheet
// should not come back mostly non-Latin, while an answer about a Japanese one
// obviously may. Only longer replies are judged, so a short answer carrying an
// accent or a currency symbol is never flagged.

const nonLatinShare = (text: string): number =>
  (text.match(/[^\x00-\xFF]/g) ?? []).length / Math.max(1, text.length);

export function looksDegenerate(answer: string, source: string): boolean {
  if (answer.length < 120) return false;
  return nonLatinShare(answer) > 0.12 && nonLatinShare(source) < 0.05;
}
