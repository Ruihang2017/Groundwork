import { describe, expect, it } from 'vitest';

import { projectNameMap } from '@/app/(app)/jobs/[id]/resume/_lib/project-names';
import { LIBRARY_FIXTURE } from '@/app/(app)/jobs/[id]/resume/_fixtures/tailored-fixtures';

describe('projectNameMap (TLR-02 plan §3.4)', () => {
  it('[machine] builds an id → name map from the library projects', () => {
    const map = projectNameMap(LIBRARY_FIXTURE);
    expect(map['voice-agent']).toBe('Voice Agent');
    expect(map['billing-migration']).toBe('Billing Migration');
  });

  it('[machine] returns an empty map for a null library', () => {
    expect(projectNameMap(null)).toEqual({});
  });

  it('[machine] has no entry for an id absent from the library (caller falls back to raw id)', () => {
    const map = projectNameMap(LIBRARY_FIXTURE);
    expect(map['ghost-project']).toBeUndefined();
  });
});
