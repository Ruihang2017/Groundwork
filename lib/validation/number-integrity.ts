// PRD §5.3: "输出中任何数值必须存在于源简历或库 metrics（服务端 regex 交叉校验，
// 违规条目剔除并计数展示）". PRD §5.5 layer 3: "产出中的数值不存在于源简历/库 →
// 剔除并计数（P2 的机器实现）". This is P2's actual enforcement mechanism
// ("Retrieve, don't generate。数字永不虚构") — see the ticket's Feedback
// obligation #3: a false negative found later during TLR-01's Q1/Q2 fixture
// testing is P0-severity (PRD §7: "证据 / 改写幻觉 P0 = 0"). The regex below is
// a starting point, not a closed/complete implementation — its known blind
// spots are documented in docs/plans/FND-07.md §4, not hidden.
//
// Matches integers, decimals, comma-grouped thousands, percentages,
// currency-prefixed amounts ($/€/£), and short-scale/multiplier suffixes
// (K/M/B/x) as used in resume metrics: "40%", "$1.2M", "3x", "12,000",
// "300ms" (extracts "300"; the unit letters "ms" are not consumed — see the
// suffix group's trailing negative lookahead, which backs off rather than
// swallowing a partial unit word).
//
// (?<![A-Za-z0-9]) leading lookbehind: excludes digits embedded in an
// identifier (e.g. the "8" in "K8s") from being treated as a numeric claim.
// (?:[KkMmBb](?![A-Za-z])|[Xx](?![A-Za-z]))? suffix group: only consumes a
// K/M/B/x suffix letter when it is NOT immediately followed by another
// letter — this is what lets "300ms"/"45min" correctly yield "300"/"45"
// instead of failing to match at all.
const NUMERIC_TOKEN_REGEX =
  /(?<![A-Za-z0-9])[$€£]?\d[\d,]*(?:\.\d+)?(?:[KkMmBb](?![A-Za-z])|[Xx](?![A-Za-z]))?%?/g;

function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/,/g, '');
}

// Reusable primitive (Deliverable 3) — used both internally by
// filterNumberIntegrity and, per the ticket, potentially by 02-evaluation's
// Q1 dropped-rate assertions. Uses String.prototype.matchAll, NOT a manual
// `while ((m = REGEX.exec(text)))` loop — matchAll does not mutate the
// passed-in regex's `lastIndex` (per the ECMAScript spec, it operates on an
// internal clone), so this function is safe to call repeatedly / reentrantly
// against the same module-level NUMERIC_TOKEN_REGEX without any risk of a
// stale `lastIndex` silently truncating a later call's matches.
export function extractNumericTokens(text: string): string[] {
  return [...text.matchAll(NUMERIC_TOKEN_REGEX)].map((match) => match[0]);
}

export function filterNumberIntegrity(
  text: string,
  sourcePool: { resumeMd: string; libraryMetrics: string[] },
): {
  result: string;
  dropped: Array<{ token: string; reason: 'number not found in source resume or library metrics' }>;
} {
  const sourceText = [sourcePool.resumeMd, ...sourcePool.libraryMetrics].join('\n');
  const sourceTokens = new Set(extractNumericTokens(sourceText).map(normalizeToken));

  const dropped: Array<{
    token: string;
    reason: 'number not found in source resume or library metrics';
  }> = [];

  let result = '';
  let cursor = 0;

  // Index-based reconstruction (NOT text.replace(token, '')) — a naive
  // replace-by-string-value approach only removes the FIRST occurrence of a
  // repeated token string, silently leaving a second occurrence of the same
  // unsupported number untouched. Iterating matches by position and splicing
  // each dropped span out individually handles repeated identical tokens
  // correctly regardless of how many times they appear.
  for (const match of text.matchAll(NUMERIC_TOKEN_REGEX)) {
    const token = match[0];
    const start = match.index ?? 0;
    const end = start + token.length;

    result += text.slice(cursor, start);

    if (sourceTokens.has(normalizeToken(token))) {
      result += token; // retained — present in source pool
    } else {
      dropped.push({ token, reason: 'number not found in source resume or library metrics' });
      // omitted from result entirely — not replaced with a placeholder
    }

    cursor = end;
  }
  result += text.slice(cursor);

  return { result, dropped };
}
