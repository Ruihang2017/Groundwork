// PRD §5.5 layer 4: "废话黑名单（regex）：'be honest' / 'stay calm' 类命中即标记
// low-quality，记录不阻断——作为 prompt 回归信号。" Ticket Deliverable 4 names
// the starter list VERBATIM (four phrases, not just PRD's two examples) — this
// is a direct transcription of the ticket's own text. Adjusting this list
// later is a product/config decision per the ticket's Feedback obligation #2
// (escalate to Horace; note in 01-foundation/README.md if it needs to change
// materially) — not a silent code edit.
//
// Every pattern carries the 'g' flag (required for String.prototype.matchAll —
// it throws a TypeError on a non-global regex) and 'i' (case-insensitive, per
// acceptance-checklist item 4: "matches 'be honest' case-insensitively").
// The apostrophe in "it's important to note" is matched as either a straight
// (') or curly (’) apostrophe — a small, low-risk robustness addition beyond
// the ticket's literal string, since LLM-generated text commonly uses curly
// quotes (flagged as a plan-level extension in docs/plans/FND-07.md §5, not
// ticket-mandated).
export const BLACKLIST_PATTERNS: RegExp[] = [
  /\bbe honest\b/gi,
  /\bstay calm\b/gi,
  /\bat the end of the day\b/gi,
  /\bit['’]s important to note\b/gi,
];

// Non-mutating, per PRD: "记录不阻断" (record, don't block). Returns matches
// only — never removes or alters `text`. Uses matchAll per pattern (not a
// stateful exec()/test() loop) for the same lastIndex-safety reason as
// number-integrity.ts's extractNumericTokens.
export function flagBlacklistedPhrases(
  text: string,
): { flagged: Array<{ pattern: string; match: string }> } {
  const flagged: Array<{ pattern: string; match: string }> = [];

  for (const pattern of BLACKLIST_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      flagged.push({ pattern: pattern.source, match: match[0] });
    }
  }

  return { flagged };
}
