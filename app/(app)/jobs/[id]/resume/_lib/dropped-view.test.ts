import { describe, expect, it } from 'vitest';

import { toDroppedItems, type TailorDropped } from '@/app/(app)/jobs/[id]/resume/_lib/dropped-view';

// TLR-02 plan §3.3 — mirrors fit-view-model's droppedFromResponse mapping, adapted to
// TAILOR's discard categories.

const dropped: TailorDropped = {
  count: 3,
  edits: [
    {
      item: { original: 'Handled a huge amount of traffic.', suggested: 's', rationale: 'r', projectId: 'p1' },
      reason: 'projectId not in library',
    },
    {
      item: { original: '', suggested: 's', rationale: 'r', projectId: 'orphan-project' },
      reason: 'projectId not in library',
    },
  ],
  numbers: [{ token: '9000000000', reason: 'not found in source' }],
};

describe('toDroppedItems (TLR-02 plan §3.3)', () => {
  it('[machine] maps edits first, then numbers (the two summands of count)', () => {
    const items = toDroppedItems(dropped);
    expect(items).toHaveLength(3);
    expect(items[0].label).toBe('Handled a huge amount of traffic.');
    expect(items[0].detail).toBe('Rewrite discarded (projectId not in library).');
    // Number entry comes last.
    expect(items[2].label).toBe('9000000000');
    expect(items[2].detail).toBe('Number removed (not found in source).');
  });

  it('[machine] falls back to the projectId when an edit original is empty', () => {
    const items = toDroppedItems(dropped);
    expect(items[1].label).toBe('orphan-project');
  });

  it('[machine] truncates a long original to ~80 chars with an ellipsis', () => {
    const long = 'x'.repeat(200);
    const items = toDroppedItems({
      count: 1,
      edits: [{ item: { original: long, suggested: 's', rationale: 'r', projectId: 'p' }, reason: 'why' }],
      numbers: [],
    });
    expect(items[0].label).toBe(`${'x'.repeat(80)}…`);
    expect(items[0].label.length).toBe(81); // 80 chars + the ellipsis
  });

  it('[machine] maps undefined (the reload path) to an empty list', () => {
    expect(toDroppedItems(undefined)).toEqual([]);
  });
});
