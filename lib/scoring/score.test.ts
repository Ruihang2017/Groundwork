import { describe, expect, it } from 'vitest';

import { computeFitReport, TOP_GAPS_CAP, tierForScore } from '@/lib/scoring/score';
import { UNCOVERED_MARKER } from '@/lib/validation';
import {
  FitReport,
  type Binding,
  type Gap,
  type HardRequirementCheck,
  type JdExtract,
  type Ledger,
  type RequirementCategory,
} from '@/lib/schemas/pipeline';

// FIT-02 — the machine-checkable acceptance surface for SCORE (PRD §5.1 SCORE row,
// §5.2 Fit Report). This function is PURE: no mocks, no PGlite, no fetch, no timers.
// Every number below is hand-computed in a comment, because a scoring test that
// merely re-implements the formula proves nothing.

// --- Builders -----------------------------------------------------------------

function req(
  id: string,
  weight: 1 | 2 | 3,
  category: RequirementCategory,
  text = `requirement ${id}`,
): JdExtract['requirements'][number] {
  return { id, text, weight, category };
}

function jdOf(...requirements: JdExtract['requirements']): JdExtract {
  return { requirements, atsKeywords: [], subtext: [] };
}

function binding(
  requirementId: string,
  strength: 'strong' | 'partial',
  projectId = 'voice-agent',
): Binding {
  return { requirementId, projectId, strength, evidence: `evidence for ${requirementId}` };
}

function gap(requirementId: string, probe = `probe ${requirementId}`, play = `play ${requirementId}`): Gap {
  return { requirementId, probe, play };
}

function ledgerOf(bindings: Binding[] = [], gaps: Gap[] = []): Ledger {
  return { bindings, gaps };
}

const NO_HARD_REQS: HardRequirementCheck[] = [];

// --- 1. Determinism (ticket acceptance item 1) --------------------------------

describe('computeFitReport — determinism (PRD §5.1 "确定性函数")', () => {
  const jd = jdOf(
    req('r1', 3, 'technical'),
    req('r2', 2, 'experience'),
    req('r3', 1, 'domain'),
    req('r4', 2, 'logistics'),
  );
  const ledger = ledgerOf(
    [binding('r1', 'strong'), binding('r2', 'partial'), binding('r4', 'strong')],
    [gap('r3')],
  );
  const hardRequirements: HardRequirementCheck[] = [
    { label: 'Work authorization', status: 'unknown' },
    { label: 'Location', status: 'pass' },
  ];

  it('[machine] byte-identical inputs ⇒ byte-identical output, twice and via a deep clone', () => {
    const a = computeFitReport(ledger, jd, hardRequirements);
    const b = computeFitReport(ledger, jd, hardRequirements);
    const c = computeFitReport(
      structuredClone(ledger),
      structuredClone(jd),
      structuredClone(hardRequirements),
    );

    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
  });

  it('[machine] mutates none of its three arguments', () => {
    const ledgerBefore = structuredClone(ledger);
    const jdBefore = structuredClone(jd);
    const hardBefore = structuredClone(hardRequirements);

    const report = computeFitReport(ledger, jd, hardRequirements);
    // ...and mutating the RETURNED report must not reach back into the inputs either.
    report.topGaps.push(gap('injected-by-caller'));
    report.hardRequirements.push({ label: 'Injected', status: 'fail' });

    expect(ledger).toEqual(ledgerBefore);
    expect(jd).toEqual(jdBefore);
    expect(hardRequirements).toEqual(hardBefore);
  });
});

// --- 2. Tier boundaries (ticket acceptance item 2) ----------------------------

describe('tierForScore — PRD §5.2 thresholds, both sides of every boundary', () => {
  const cases: Array<[number, string]> = [
    [100, 'Strong'],
    [75, 'Strong'],
    [74, 'Competitive'],
    [55, 'Competitive'],
    [54, 'Stretch'],
    [35, 'Stretch'],
    [34, 'Long shot'],
    [0, 'Long shot'],
  ];

  for (const [score, tier] of cases) {
    it(`[machine] ${score} ⇒ '${tier}'`, () => {
      expect(tierForScore(score)).toBe(tier);
    });
  }

  it('[machine] the mapping is really WIRED: a ledger that computes to exactly 75 is Strong', () => {
    // technical: r1 (w1, strong ⇒ 1) + r2 (w1, gap ⇒ 0) = 1/2 ⇒ 50
    // evidenceStrength: r1 only (w1, strong)            = 1/1 ⇒ 100
    // experienceDepth / domain: not assessed, excluded (D6)
    // composite = round((50 + 100) / 2) = 75 ⇒ 'Strong'
    const jd = jdOf(req('r1', 1, 'technical'), req('r2', 1, 'technical'));
    const report = computeFitReport(ledgerOf([binding('r1', 'strong')], [gap('r2')]), jd, NO_HARD_REQS);

    expect(report.subScores.technical.score).toBe(50);
    expect(report.subScores.evidenceStrength.score).toBe(100);
    expect(report.compositeScore).toBe(75);
    expect(report.tier).toBe('Strong');
  });
});

// --- 3. Weighted arithmetic (PRD §5.1 "按 requirement weight 加权归一") --------

describe('computeFitReport — the weighted formula', () => {
  it('[machine] weight 3 strong + weight 1 gap ⇒ round(3/4 * 100) = 75', () => {
    const jd = jdOf(req('r1', 3, 'technical'), req('r2', 1, 'technical'));
    const report = computeFitReport(ledgerOf([binding('r1', 'strong')], [gap('r2')]), jd, NO_HARD_REQS);
    expect(report.subScores.technical.score).toBe(75);
  });

  it('[machine] a single weight-2 partial ⇒ 50 (partial = 0.5, normalised)', () => {
    const jd = jdOf(req('r1', 2, 'technical'));
    const report = computeFitReport(ledgerOf([binding('r1', 'partial')]), jd, NO_HARD_REQS);
    expect(report.subScores.technical.score).toBe(50);
  });

  it('[machine] mixed strong/partial/gap across weights 1–3 ⇒ 67 (hand-computed)', () => {
    // r1 w3 strong  → 3 * 1   = 3
    // r2 w2 partial → 2 * 0.5 = 1
    // r3 w1 gap     → 1 * 0   = 0
    // weightSum 6, weightedValue 4 ⇒ round(66.666…) = 67   (Math.round, half-up)
    const jd = jdOf(req('r1', 3, 'technical'), req('r2', 2, 'technical'), req('r3', 1, 'technical'));
    const report = computeFitReport(
      ledgerOf([binding('r1', 'strong'), binding('r2', 'partial')], [gap('r3')]),
      jd,
      NO_HARD_REQS,
    );
    expect(report.subScores.technical.score).toBe(67);
  });

  it('[machine] rounding is half-UP (Math.round): 12.5 ⇒ 13, never 12', () => {
    // r1 w1 partial → 1 * 0.5 = 0.5 ; r2 w3 gap → 0. weightSum 4 ⇒ 0.5/4 = 12.5%.
    // Banker's rounding would give 12 here and silently shift every tier boundary.
    const jd = jdOf(req('r1', 1, 'technical'), req('r2', 3, 'technical'));
    const report = computeFitReport(ledgerOf([binding('r1', 'partial')], [gap('r2')]), jd, NO_HARD_REQS);
    expect(report.subScores.technical.score).toBe(13); // 12.5 → 13, not 12
  });
});

// --- 4. Strongest binding wins ------------------------------------------------

describe('computeFitReport — a requirement is scored by its strongest binding', () => {
  it('[machine] partial + strong on one requirement ⇒ value 1, listed ONCE', () => {
    const jd = jdOf(req('r1', 2, 'technical'));
    const report = computeFitReport(
      ledgerOf([binding('r1', 'partial', 'project-a'), binding('r1', 'strong', 'project-b')]),
      jd,
      NO_HARD_REQS,
    );
    expect(report.subScores.technical.score).toBe(100);
    expect(report.subScores.technical.bindings).toEqual(['r1']);
    expect(report.subScores.evidenceStrength.bindings).toEqual(['r1']);
  });

  it('[machine] duplicate identical bindings cannot inflate a score (plan §4 R8)', () => {
    const jd = jdOf(req('r1', 1, 'technical'), req('r2', 1, 'technical'));
    const dup = computeFitReport(
      ledgerOf([binding('r1', 'partial'), binding('r1', 'partial')], [gap('r2')]),
      jd,
      NO_HARD_REQS,
    );
    const single = computeFitReport(
      ledgerOf([binding('r1', 'partial')], [gap('r2')]),
      jd,
      NO_HARD_REQS,
    );
    expect(dup.subScores.technical.score).toBe(single.subScores.technical.score);
    expect(dup.compositeScore).toBe(single.compositeScore);
  });
});

// --- 5. Category mapping (D5) -------------------------------------------------

describe('computeFitReport — category → bucket mapping (D5)', () => {
  it('[machine] experience ⇒ experienceDepth, domain ⇒ domain', () => {
    const jd = jdOf(req('r1', 2, 'experience'), req('r2', 2, 'domain'));
    const report = computeFitReport(
      ledgerOf([binding('r1', 'strong')], [gap('r2')]),
      jd,
      NO_HARD_REQS,
    );
    expect(report.subScores.experienceDepth).toEqual({ score: 100, bindings: ['r1'], gaps: [] });
    expect(report.subScores.domain).toEqual({ score: 0, bindings: [], gaps: ['r2'] });
    expect(report.subScores.technical).toEqual({ score: 0, bindings: [], gaps: [] });
  });

  it('[machine] a logistics requirement joins NO category bucket…', () => {
    const withoutLogistics = computeFitReport(
      ledgerOf([binding('r1', 'strong')]),
      jdOf(req('r1', 3, 'technical')),
      NO_HARD_REQS,
    );
    const withLogistics = computeFitReport(
      ledgerOf([binding('r1', 'strong')], [gap('r2')]),
      jdOf(req('r1', 3, 'technical'), req('r2', 3, 'logistics')),
      NO_HARD_REQS,
    );

    expect(withLogistics.subScores.technical).toEqual(withoutLogistics.subScores.technical);
    expect(withLogistics.subScores.experienceDepth.gaps).toEqual([]);
    expect(withLogistics.subScores.domain.gaps).toEqual([]);
  });

  it('[machine] …but a BOUND logistics requirement does move evidenceStrength (D4 is category-blind)', () => {
    // r1 technical w1 strong (1/1), r2 logistics w3 partial (3 * 0.5 = 1.5)
    // evidenceStrength: weightSum 4, weightedValue 2.5 ⇒ round(62.5) = 63
    const jd = jdOf(req('r1', 1, 'technical'), req('r2', 3, 'logistics'));
    const report = computeFitReport(
      ledgerOf([binding('r1', 'strong'), binding('r2', 'partial')]),
      jd,
      NO_HARD_REQS,
    );
    expect(report.subScores.evidenceStrength.score).toBe(63);
    expect(report.subScores.evidenceStrength.bindings).toEqual(['r1', 'r2']);
  });
});

// --- 6. evidenceStrength (D4) -------------------------------------------------

describe('computeFitReport — evidenceStrength (D4, the ticket\'s own resolution)', () => {
  it('[machine] weighted over BOUND requirements only, and unaffected by how many gaps exist', () => {
    const bound = [binding('r1', 'strong'), binding('r2', 'partial')];
    // r1 w1 strong (1), r2 w1 partial (0.5) ⇒ 1.5/2 ⇒ 75
    const few = computeFitReport(
      ledgerOf(bound, [gap('r3')]),
      jdOf(req('r1', 1, 'technical'), req('r2', 1, 'technical'), req('r3', 1, 'technical')),
      NO_HARD_REQS,
    );
    const many = computeFitReport(
      ledgerOf(bound, [gap('r3'), gap('r4'), gap('r5')]),
      jdOf(
        req('r1', 1, 'technical'),
        req('r2', 1, 'technical'),
        req('r3', 3, 'technical'),
        req('r4', 3, 'technical'),
        req('r5', 3, 'technical'),
      ),
      NO_HARD_REQS,
    );

    expect(few.subScores.evidenceStrength.score).toBe(75);
    expect(many.subScores.evidenceStrength.score).toBe(75);
    // ...while the coverage-sensitive technical bucket collapses. This asymmetry is
    // exactly plan §4 R11's documented consequence of D4.
    expect(few.subScores.technical.score).toBe(50);
    expect(many.subScores.technical.score).toBe(14); // 1.5 / 11 ⇒ 13.6 → 14
  });

  it('[machine] no bindings at all ⇒ score 0, bindings [], gaps lists every requirement id', () => {
    const jd = jdOf(req('r1', 3, 'technical'), req('r2', 1, 'domain'));
    const report = computeFitReport(ledgerOf([], [gap('r1'), gap('r2')]), jd, NO_HARD_REQS);
    expect(report.subScores.evidenceStrength).toEqual({ score: 0, bindings: [], gaps: ['r1', 'r2'] });
    expect(report.compositeScore).toBe(0);
    expect(report.tier).toBe('Long shot');
  });
});

// --- 7. Not-assessed buckets (D6) ---------------------------------------------

describe('computeFitReport — "not assessed" buckets are excluded from the composite (D6)', () => {
  it('[machine] a technical-only JD leaves experienceDepth/domain empty and out of the average', () => {
    // technical: r1 w3 strong (3) + r2 w1 partial (0.5) ⇒ 3.5/4 ⇒ round(87.5) = 88
    // evidenceStrength: same two requirements ⇒ 88
    // composite = round((88 + 88) / 2) = 88, NOT round((88+88+0+0)/4) = 44
    const jd = jdOf(req('r1', 3, 'technical'), req('r2', 1, 'technical'));
    const report = computeFitReport(
      ledgerOf([binding('r1', 'strong'), binding('r2', 'partial')]),
      jd,
      NO_HARD_REQS,
    );

    expect(report.subScores.technical.score).toBe(88);
    expect(report.subScores.evidenceStrength.score).toBe(88);
    expect(report.subScores.experienceDepth).toEqual({ score: 0, bindings: [], gaps: [] });
    expect(report.subScores.domain).toEqual({ score: 0, bindings: [], gaps: [] });
    expect(report.compositeScore).toBe(88);
    expect(report.tier).toBe('Strong');
  });

  it('[machine] a JD with zero requirements ⇒ all sub-scores 0, composite 0, Long shot, no topGaps', () => {
    const report = computeFitReport(ledgerOf(), jdOf(), NO_HARD_REQS);
    expect(report.subScores).toEqual({
      technical: { score: 0, bindings: [], gaps: [] },
      experienceDepth: { score: 0, bindings: [], gaps: [] },
      domain: { score: 0, bindings: [], gaps: [] },
      evidenceStrength: { score: 0, bindings: [], gaps: [] },
    });
    expect(report.compositeScore).toBe(0);
    expect(report.tier).toBe('Long shot');
    expect(report.topGaps).toEqual([]);
  });
});

// --- 8. SubScore array contents (D3) ------------------------------------------

describe('computeFitReport — SubScore arrays hold requirementId strings in jd order (D3)', () => {
  it('[machine] ids, not indices; jd.requirements order; no duplicates', () => {
    const jd = jdOf(
      req('r1', 1, 'technical'),
      req('r2', 1, 'technical'),
      req('r3', 1, 'technical'),
      req('r4', 1, 'technical'),
    );
    // Ledger deliberately emitted OUT of jd order — the output must not inherit it.
    const report = computeFitReport(
      ledgerOf(
        [binding('r3', 'strong'), binding('r1', 'partial'), binding('r1', 'strong')],
        [gap('r4'), gap('r2')],
      ),
      jd,
      NO_HARD_REQS,
    );

    expect(report.subScores.technical.bindings).toEqual(['r1', 'r3']);
    expect(report.subScores.technical.gaps).toEqual(['r2', 'r4']);
    expect(new Set(report.subScores.technical.bindings).size).toBe(2);
  });
});

// --- 9. topGaps (D8) ----------------------------------------------------------

describe('computeFitReport — topGaps (D8)', () => {
  it('[machine] weight desc, then jd order, capped at TOP_GAPS_CAP', () => {
    expect(TOP_GAPS_CAP).toBe(3);
    const jd = jdOf(
      req('r1', 1, 'technical'),
      req('r2', 3, 'technical'),
      req('r3', 2, 'technical'),
      req('r4', 3, 'technical'),
      req('r5', 2, 'technical'),
    );
    const report = computeFitReport(
      ledgerOf([], [gap('r1'), gap('r2'), gap('r3'), gap('r4'), gap('r5')]),
      jd,
      NO_HARD_REQS,
    );
    // weight 3: r2 (jd index 1), r4 (index 3); weight 2: r3 (2), r5 (4); weight 1: r1
    expect(report.topGaps.map((g) => g.requirementId)).toEqual(['r2', 'r4', 'r3']);
  });

  it('[machine] a gap whose requirement also has a binding is excluded (D11 resolved as bound)', () => {
    const jd = jdOf(req('r1', 3, 'technical'), req('r2', 1, 'technical'));
    const report = computeFitReport(
      ledgerOf([binding('r1', 'strong')], [gap('r1'), gap('r2')]),
      jd,
      NO_HARD_REQS,
    );
    expect(report.topGaps.map((g) => g.requirementId)).toEqual(['r2']);
  });

  it('[machine] a layer-2 injected "uncovered — rerun" gap IS eligible', () => {
    const jd = jdOf(req('r1', 3, 'technical'));
    const report = computeFitReport(
      ledgerOf([], [{ requirementId: 'r1', probe: UNCOVERED_MARKER, play: '' }]),
      jd,
      NO_HARD_REQS,
    );
    expect(report.topGaps).toEqual([{ requirementId: 'r1', probe: UNCOVERED_MARKER, play: '' }]);
  });

  it('[machine] a gap whose requirementId is not in the JD sorts LAST (weight 0)', () => {
    const jd = jdOf(req('r1', 1, 'technical'));
    const report = computeFitReport(
      ledgerOf([], [gap('hallucinated'), gap('r1')]),
      jd,
      NO_HARD_REQS,
    );
    expect(report.topGaps.map((g) => g.requirementId)).toEqual(['r1', 'hallucinated']);
  });

  it('[machine] ordering is total and stable for equal weights (original ledger order breaks ties)', () => {
    const jd = jdOf(req('r1', 2, 'technical'), req('r2', 2, 'technical'));
    const a = computeFitReport(ledgerOf([], [gap('r2'), gap('r1')]), jd, NO_HARD_REQS);
    const b = computeFitReport(ledgerOf([], [gap('r1'), gap('r2')]), jd, NO_HARD_REQS);
    // jd index wins over ledger order, so both orderings produce r1 then r2.
    expect(a.topGaps.map((g) => g.requirementId)).toEqual(['r1', 'r2']);
    expect(b.topGaps.map((g) => g.requirementId)).toEqual(['r1', 'r2']);
  });
});

// --- 10. Unknown requirement ids ----------------------------------------------

describe('computeFitReport — references to requirements the JD does not contain', () => {
  it('[machine] a binding for an unknown requirementId changes no score and appears in no array', () => {
    const jd = jdOf(req('r1', 2, 'technical'));
    const withGhost = computeFitReport(
      ledgerOf([binding('r1', 'partial'), binding('ghost', 'strong')]),
      jd,
      NO_HARD_REQS,
    );
    const without = computeFitReport(ledgerOf([binding('r1', 'partial')]), jd, NO_HARD_REQS);

    expect(withGhost.subScores).toEqual(without.subScores);
    expect(withGhost.compositeScore).toBe(without.compositeScore);
    const allIds = Object.values(withGhost.subScores).flatMap((s) => [...s.bindings, ...s.gaps]);
    expect(allIds).not.toContain('ghost');
  });
});

// --- 11. Pass-through + schema ------------------------------------------------

describe('computeFitReport — hardRequirements pass-through and schema self-check', () => {
  it('[machine] hardRequirements are returned unchanged, in order', () => {
    const hard: HardRequirementCheck[] = [
      { label: 'Work authorization', status: 'unknown' },
      { label: 'Location', status: 'fail' },
      { label: 'Years of experience', status: 'pass' },
    ];
    const report = computeFitReport(ledgerOf(), jdOf(req('r1', 1, 'technical')), hard);
    expect(report.hardRequirements).toEqual(hard);
  });

  it('[machine] the returned object parses against FND-03 s FitReport', () => {
    const jd = jdOf(req('r1', 3, 'technical'), req('r2', 2, 'experience'), req('r3', 1, 'domain'));
    const report = computeFitReport(
      ledgerOf([binding('r1', 'strong'), binding('r2', 'partial')], [gap('r3')]),
      jd,
      [{ label: 'Language', status: 'pass' }],
    );
    expect(FitReport.safeParse(report).success).toBe(true);
  });
});

// --- 12. advice (D9, PRD §5.2 "不是录取概率") ---------------------------------

describe('computeFitReport — advice (D9)', () => {
  const PROBABILITY_LANGUAGE = /probability|chance of|odds|likely to get|will be hired/i;

  const tierCases: Array<[string, Ledger, JdExtract]> = [
    // Strong: single weight-1 strong technical ⇒ technical 100, evidence 100 ⇒ 100
    ['Strong', ledgerOf([binding('r1', 'strong')]), jdOf(req('r1', 1, 'technical'))],
    // Competitive: r1 strong + r2/r3/r4 gaps ⇒ technical 25, evidence 100 ⇒ 63
    [
      'Competitive',
      ledgerOf([binding('r1', 'strong')], [gap('r2'), gap('r3'), gap('r4')]),
      jdOf(
        req('r1', 1, 'technical'),
        req('r2', 1, 'technical'),
        req('r3', 1, 'technical'),
        req('r4', 1, 'technical'),
      ),
    ],
    // Stretch: r1 partial + 3 gaps ⇒ technical 13, evidence 50 ⇒ round(31.5) = 32… so
    // use r1 partial + 1 gap ⇒ technical 25, evidence 50 ⇒ 38.
    [
      'Stretch',
      ledgerOf([binding('r1', 'partial')], [gap('r2')]),
      jdOf(req('r1', 1, 'technical'), req('r2', 1, 'technical')),
    ],
    // Long shot: no bindings at all ⇒ 0
    ['Long shot', ledgerOf([], [gap('r1')]), jdOf(req('r1', 1, 'technical'))],
  ];

  const seen = new Map<string, string>();

  for (const [expectedTier, ledger, jd] of tierCases) {
    it(`[machine] ${expectedTier} advice is non-empty, tier-specific and probability-free`, () => {
      const report = computeFitReport(ledger, jd, NO_HARD_REQS);
      expect(report.tier).toBe(expectedTier);
      expect(report.advice.trim().length).toBeGreaterThan(0);
      expect(report.advice).not.toMatch(PROBABILITY_LANGUAGE);
      seen.set(expectedTier, report.advice);
    });
  }

  it('[machine] all four tiers give DIFFERENT advice', () => {
    expect(seen.size).toBe(4);
    expect(new Set(seen.values()).size).toBe(4);
  });
});
