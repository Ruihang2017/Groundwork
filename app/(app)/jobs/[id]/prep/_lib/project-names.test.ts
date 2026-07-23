import { describe, expect, it } from 'vitest';

import { LIBRARY_FIXTURE } from '@/app/(app)/jobs/[id]/prep/_fixtures/brief-fixtures';
import { projectNameMap } from '@/app/(app)/jobs/[id]/prep/_lib/project-names';

// PRP-04 (plan §2.5 / D12) — this module's own projectId → name map. Node environment (no DOM).

describe('projectNameMap (PRP-04 plan §2.5)', () => {
  it('[machine] builds an id → name map from the library projects', () => {
    const map = projectNameMap(LIBRARY_FIXTURE);
    expect(map['voice-agent']).toBe('Voice Agent');
    expect(map['billing-migration']).toBe('Billing Migration');
    expect(map['search-ranking']).toBe('Search Ranking');
  });

  it('[machine] returns an empty map for a null library', () => {
    expect(projectNameMap(null)).toEqual({});
  });

  it('[machine] has no entry for an id absent from the library (caller falls back to raw id)', () => {
    const map = projectNameMap(LIBRARY_FIXTURE);
    expect(map['ghost-project']).toBeUndefined();
  });
});
