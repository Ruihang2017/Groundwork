import type { Edit } from '@/lib/schemas/pipeline';

// TLR-02 Deliverable 3's load-bearing pure function (plan §3.1). Acceptance item 3
// tests THIS directly. No React, no I/O, no mutation of arguments.
//
// PRD §5.3's "用户逐条采纳，不是黑盒整篇替换": only the edits the user has ACCEPTED are
// applied to `fullDraftMd`; a non-accepted edit's `original` text is left verbatim. This
// is the derivation the workspace re-runs whenever the user toggles an edit.
//
// LITERAL REPLACEMENT (plan §3.1, strengthened). The plan names
// `String.prototype.replace(searchString, replacement)` to keep the SEARCH string
// literal (a model `original` containing regex metacharacters must not be treated as a
// pattern). We use `indexOf` + `slice` instead, which is literal on BOTH sides: the
// `replacement` argument of `String.prototype.replace` still interprets `$&`/`$1`/`$$`
// specially even when the search is a plain string, so a `suggested` text containing a
// dollar sign (a salary figure, "$40M ARR") would be silently corrupted. `indexOf`+
// `slice` inserts `suggested` byte-for-byte. Same first-occurrence-only semantics.
// Recorded as a deviation in the ticket writeback.

/**
 * Apply only the ACCEPTED edits to `fullDraftMd`, in place, in array order.
 *
 * For each index `i`, if `acceptedIndices.has(i)` and `edits[i].original !== ''`,
 * replace the FIRST occurrence of `edits[i].original` in the working string with
 * `edits[i].suggested`. Non-accepted edits are skipped (their `original` stays verbatim).
 * An `original` not found in the working string is a no-op — an unmatched anchor cannot
 * be placed, so `suggested` is NOT inserted anywhere. An empty `original` is skipped
 * (guards against a degenerate whole-string mangle). Because each accepted edit's
 * `suggested` becomes part of the working string, a later edit can match text an earlier
 * one produced — accepted, deterministic given array order.
 */
export function deriveDraft(
  fullDraftMd: string,
  edits: readonly Edit[],
  acceptedIndices: ReadonlySet<number>,
): string {
  let working = fullDraftMd;
  for (let i = 0; i < edits.length; i += 1) {
    if (!acceptedIndices.has(i)) continue;
    const { original, suggested } = edits[i];
    if (original === '') continue;
    const at = working.indexOf(original);
    if (at === -1) continue;
    working = working.slice(0, at) + suggested + working.slice(at + original.length);
  }
  return working;
}
