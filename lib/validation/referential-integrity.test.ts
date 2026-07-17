import { describe, expect, it } from 'vitest';

import type { Library } from '@/lib/schemas/entities';
import type { Binding, Edit, RehearseQuestion } from '@/lib/schemas/pipeline';
import {
  filterByReferentialIntegrity,
  getValidProjectIds,
} from '@/lib/validation/referential-integrity';

// Hand-built inline fixtures only — no fixtures/** reference (02-evaluation's
// corpus does not exist yet at this point in the DAG). Pure value assertions.

const validIds = new Set(['voice-agent', 'payments-core']);

const makeBinding = (projectId: string): Binding => ({
  requirementId: 'r1',
  projectId,
  strength: 'strong',
  evidence: 'evidence text',
});

const makeEdit = (projectId: string): Edit => ({
  original: 'original text',
  suggested: 'suggested text',
  rationale: 'rationale text',
  projectId,
});

const makeQuestion = (projectId: string): RehearseQuestion => ({
  projectId,
  question: 'How did you scale the system?',
  trap: 'What was the failure mode?',
});

describe('filterByReferentialIntegrity', () => {
  it('drops items whose projectId is not in the valid set, keeps valid ones (Binding)', () => {
    const items = [
      makeBinding('voice-agent'),
      makeBinding('ghost-project'),
      makeBinding('payments-core'),
    ];

    const { result, dropped } = filterByReferentialIntegrity(items, validIds);

    expect(result).toHaveLength(2);
    expect(result.map((b) => b.projectId)).toEqual(['voice-agent', 'payments-core']);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toEqual({
      item: makeBinding('ghost-project'),
      reason: 'projectId not in library',
    });
  });

  it('works generically over Edit-shaped items', () => {
    const items = [makeEdit('voice-agent'), makeEdit('nope')];
    const { result, dropped } = filterByReferentialIntegrity(items, validIds);
    expect(result).toHaveLength(1);
    expect(result[0].projectId).toBe('voice-agent');
    expect(dropped).toHaveLength(1);
    expect(dropped[0].item.projectId).toBe('nope');
  });

  it('works generically over RehearseQuestion-shaped items', () => {
    const items = [makeQuestion('payments-core'), makeQuestion('missing')];
    const { result, dropped } = filterByReferentialIntegrity(items, validIds);
    expect(result).toHaveLength(1);
    expect(result[0].projectId).toBe('payments-core');
    expect(dropped).toHaveLength(1);
    expect(dropped[0].item.projectId).toBe('missing');
  });

  it('returns empty result and dropped for an empty items array', () => {
    const { result, dropped } = filterByReferentialIntegrity([], validIds);
    expect(result).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('is case-sensitive: a projectId differing only in case is dropped, not matched', () => {
    const items = [makeBinding('Voice-Agent')];
    const { result, dropped } = filterByReferentialIntegrity(items, validIds);
    expect(result).toEqual([]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].item.projectId).toBe('Voice-Agent');
  });

  it('does not mutate the input items array', () => {
    const items = [makeBinding('voice-agent'), makeBinding('ghost')];
    const snapshot = JSON.parse(JSON.stringify(items));
    filterByReferentialIntegrity(items, validIds);
    expect(items).toEqual(snapshot);
    expect(items).toHaveLength(2);
  });
});

describe('getValidProjectIds', () => {
  const makeProject = (id: string) => ({
    id,
    name: `Project ${id}`,
    stage: 'shipped',
    role: 'lead',
    stack: ['ts'],
    summary: 'summary',
    metrics: [],
    tags: [],
  });

  it('returns a Set of exactly the library project ids', () => {
    const library: Library = {
      profile: { name: 'Ada' },
      projects: [makeProject('voice-agent'), makeProject('payments-core')],
    };
    const ids = getValidProjectIds(library);
    expect(ids).toBeInstanceOf(Set);
    expect([...ids].sort()).toEqual(['payments-core', 'voice-agent']);
  });

  it('returns an empty Set for a library with no projects', () => {
    const library: Library = { profile: { name: 'Ada' }, projects: [] };
    expect(getValidProjectIds(library).size).toBe(0);
  });
});
