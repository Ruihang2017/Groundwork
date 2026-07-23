import { describe, expect, it } from 'vitest';

import { deriveDraft } from '@/app/(app)/jobs/[id]/resume/_lib/draft-derivation';
import type { Edit } from '@/lib/schemas/pipeline';

// TLR-02 acceptance item 3 (the most load-bearing unit test — a pure function, exhaustively
// testable offline). Runs in the default `node` env (no DOM, no mocks).

function edit(original: string, suggested: string): Edit {
  return { original, suggested, rationale: 'r', projectId: 'p' };
}

describe('deriveDraft (TLR-02 acceptance item 3; PRD §5.3 用户逐条采纳)', () => {
  it('[machine] substitutes ONLY accepted edits, leaving non-accepted originals verbatim', () => {
    const draft = 'Alpha. Bravo. Charlie.';
    const edits = [edit('Alpha.', 'ALPHA!'), edit('Bravo.', 'BRAVO!'), edit('Charlie.', 'CHARLIE!')];

    // Accept indices 0 and 2 only.
    const result = deriveDraft(draft, edits, new Set([0, 2]));

    expect(result).toBe('ALPHA! Bravo. CHARLIE!');
    // Bravo's original survives untouched; its suggested text never appears.
    expect(result).toContain('Bravo.');
    expect(result).not.toContain('BRAVO!');
  });

  it('[machine] an empty accepted set returns fullDraftMd unchanged', () => {
    const draft = '# Title\n\nBody with some text.';
    const edits = [edit('Body', 'REWRITTEN')];
    expect(deriveDraft(draft, edits, new Set())).toBe(draft);
  });

  it('[machine] compounds in array order — a later edit can match earlier suggested text', () => {
    const draft = 'one two three';
    // Edit 0 turns "two" into "TWO"; edit 1 then matches the produced "TWO".
    const edits = [edit('two', 'TWO'), edit('TWO', 'DEUX')];
    expect(deriveDraft(draft, edits, new Set([0, 1]))).toBe('one DEUX three');
  });

  it('[machine] an original absent from the draft is a no-op — suggested is NOT inserted', () => {
    const draft = 'nothing to see here';
    const edits = [edit('MISSING ANCHOR', 'should not appear')];
    const result = deriveDraft(draft, edits, new Set([0]));
    expect(result).toBe(draft);
    expect(result).not.toContain('should not appear');
  });

  it('[machine] an empty original is skipped (no degenerate whole-string mangle)', () => {
    const draft = 'keep me intact';
    const edits = [edit('', 'INJECTED')];
    expect(deriveDraft(draft, edits, new Set([0]))).toBe(draft);
  });

  it('[machine] replaces only the FIRST occurrence, literally, with regex metacharacters', () => {
    // `original` contains regex metacharacters; a RegExp search would misbehave. Two
    // occurrences of the anchor — only the first is replaced.
    const draft = 'cost is $5.00 (approx) and again $5.00 (approx)';
    const edits = [edit('$5.00 (approx)', '$5.00 exactly')];
    const result = deriveDraft(draft, edits, new Set([0]));
    expect(result).toBe('cost is $5.00 exactly and again $5.00 (approx)');
  });

  it('[machine] inserts suggested LITERALLY even when it contains $-substitution patterns', () => {
    // `String.prototype.replace(str, repl)` would interpret `$&`/`$1` in the replacement;
    // deriveDraft must insert the suggested text byte-for-byte.
    const draft = 'placeholder';
    const edits = [edit('placeholder', 'earned $1 and kept $& intact')];
    expect(deriveDraft(draft, edits, new Set([0]))).toBe('earned $1 and kept $& intact');
  });

  it('[machine] does not mutate its arguments', () => {
    const edits = [edit('a', 'A')];
    const set = new Set([0]);
    const frozenEdits = Object.freeze([...edits]);
    deriveDraft('a b c', frozenEdits, set);
    // The set is unchanged and no throw occurred from mutating a frozen array.
    expect([...set]).toEqual([0]);
    expect(frozenEdits[0].original).toBe('a');
  });
});
