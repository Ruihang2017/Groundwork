import { describe, expect, it } from 'vitest';

import type { JdExtract, Ledger } from '@/lib/schemas/pipeline';
import {
  ensureRequirementCoverage,
  UNCOVERED_MARKER,
} from '@/lib/validation/requirement-coverage';

// Hand-built inline fixtures only — no fixtures/** reference.

const makeRequirement = (id: string): JdExtract['requirements'][number] => ({
  id,
  text: `requirement ${id}`,
  weight: 2,
  category: 'technical',
});

const jd = (ids: string[]): JdExtract => ({
  requirements: ids.map(makeRequirement),
  atsKeywords: [],
  subtext: [],
});

describe('ensureRequirementCoverage', () => {
  it('injects exactly one Gap with the uncovered marker for an uncovered requirement', () => {
    const extract = jd(['r1', 'r2']);
    const ledger: Ledger = {
      bindings: [
        { requirementId: 'r1', projectId: 'voice-agent', strength: 'strong', evidence: 'e' },
      ],
      gaps: [],
    };

    const { result, injectedGaps } = ensureRequirementCoverage(extract, ledger);

    expect(injectedGaps).toHaveLength(1);
    expect(injectedGaps[0]).toEqual({
      requirementId: 'r2',
      probe: UNCOVERED_MARKER,
      play: '',
    });
    expect(UNCOVERED_MARKER).toBe('uncovered — rerun');

    // result.gaps = original gaps (none) + injected one
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].requirementId).toBe('r2');
    // bindings carried through untouched in content
    expect(result.bindings).toEqual(ledger.bindings);
  });

  it('injects nothing when every requirement is already covered', () => {
    const extract = jd(['r1', 'r2']);
    const ledger: Ledger = {
      bindings: [
        { requirementId: 'r1', projectId: 'voice-agent', strength: 'partial', evidence: 'e' },
      ],
      gaps: [{ requirementId: 'r2', probe: 'how will you learn X?', play: 'bridge via Y' }],
    };

    const { result, injectedGaps } = ensureRequirementCoverage(extract, ledger);

    expect(injectedGaps).toEqual([]);
    expect(result.bindings).toEqual(ledger.bindings);
    expect(result.gaps).toEqual(ledger.gaps);
  });

  it('does not mutate the input ledger and returns fresh object/array references', () => {
    const extract = jd(['r1', 'r2']);
    const ledger: Ledger = {
      bindings: [
        { requirementId: 'r1', projectId: 'voice-agent', strength: 'strong', evidence: 'e' },
      ],
      gaps: [],
    };
    const snapshot = JSON.parse(JSON.stringify(ledger));

    const { result } = ensureRequirementCoverage(extract, ledger);

    // input unchanged
    expect(ledger).toEqual(snapshot);
    expect(ledger.gaps).toHaveLength(0);
    // fresh references
    expect(result).not.toBe(ledger);
    expect(result.gaps).not.toBe(ledger.gaps);
    expect(result.bindings).not.toBe(ledger.bindings);
  });

  it('injects one gap per uncovered requirement, in jd.requirements order', () => {
    const extract = jd(['r1', 'r2', 'r3', 'r4']);
    const ledger: Ledger = {
      bindings: [
        { requirementId: 'r2', projectId: 'voice-agent', strength: 'strong', evidence: 'e' },
      ],
      gaps: [],
    };

    const { injectedGaps } = ensureRequirementCoverage(extract, ledger);

    expect(injectedGaps.map((g) => g.requirementId)).toEqual(['r1', 'r3', 'r4']);
    expect(injectedGaps.every((g) => g.probe === UNCOVERED_MARKER && g.play === '')).toBe(true);
  });
});
