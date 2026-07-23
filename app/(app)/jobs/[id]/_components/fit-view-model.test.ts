import { describe, expect, it } from 'vitest';

import {
  EMPTY_JD_FIXTURE,
  EMPTY_LEDGER_FIXTURE,
  JD_FIXTURE,
  LEDGER_FIXTURE,
  NOT_ASSESSED_SUB_SCORE,
  fitFixture,
  fitResponseFixture,
  jobFixture,
} from '@/app/(app)/jobs/_fixtures/job-fixtures';
import {
  droppedFromLedger,
  droppedFromResponse,
  hasUnassessedBucket,
  isNotAssessed,
  resolveRequirements,
  SUB_SCORE_KEYS,
  SUB_SCORE_LABELS,
  uncoveredGaps,
} from '@/app/(app)/jobs/[id]/_components/fit-view-model';
import { FitReport, JdExtract, Ledger } from '@/lib/schemas/pipeline';
import { UNCOVERED_MARKER } from '@/lib/validation';

// NODE environment (no `@vitest-environment jsdom` line) — this module is pure and
// has no DOM to need.
//
// HONESTY NOTE (required in every test file in this ticket): nothing here proves the
// Fit Report is CORRECT. Every ledger and fit in these fixtures is one this repo
// wrote. These tests prove derivation, wiring, gating and copy. Model quality is
// `pnpm eval`'s job (Q1/Q2); legibility and tone are the ticket's [human] acceptance
// item (Horace's P2 dogfood pass). A green run here is not "the Fit Report is good".

describe('fit-view-model — fixture integrity (the guard against a lying fixture)', () => {
  // If a fixture has drifted from FND-03's schemas, every component test in this
  // ticket goes green against a shape that never occurs in production. These four
  // assertions are what make the other files' greens mean something.
  it('[machine] JD_FIXTURE parses as JdExtract', () => {
    expect(JdExtract.safeParse(JD_FIXTURE).success).toBe(true);
    expect(JdExtract.safeParse(EMPTY_JD_FIXTURE).success).toBe(true);
  });

  it('[machine] LEDGER_FIXTURE parses as Ledger', () => {
    expect(Ledger.safeParse(LEDGER_FIXTURE).success).toBe(true);
    expect(Ledger.safeParse(EMPTY_LEDGER_FIXTURE).success).toBe(true);
  });

  it('[machine] fitFixture() parses as FitReport, with and without overrides', () => {
    expect(FitReport.safeParse(fitFixture()).success).toBe(true);
    expect(FitReport.safeParse(fitFixture({ tier: 'Long shot', compositeScore: 12 })).success).toBe(
      true,
    );
  });

  it('[machine] jobFixture()/fitResponseFixture() carry a complete, schema-valid job', () => {
    const job = jobFixture();
    expect(JdExtract.safeParse(job.jd).success).toBe(true);
    expect(Ledger.safeParse(job.ledger).success).toBe(true);
    expect(FitReport.safeParse(job.fit).success).toBe(true);

    const body = fitResponseFixture();
    expect(FitReport.safeParse(body.fit).success).toBe(true);
    // FIT-02's contract: count == layer-1 discards + layer-2 injections.
    expect(body.dropped.count).toBe(
      body.dropped.bindings.length + body.dropped.uncoveredRequirementIds.length,
    );
  });

  it('[machine] the injected gap really carries the em-dash marker and an empty play', () => {
    // Pins E8: a hand-typed 'uncovered - rerun' (hyphen) would compile and never match.
    const injected = LEDGER_FIXTURE.gaps.find((g) => g.requirementId === 'r5');
    expect(injected?.probe).toBe(UNCOVERED_MARKER);
    expect(injected?.play).toBe('');
  });
});

describe('fit-view-model — resolveRequirements (PRD §5.2 "分数可下钻到证据")', () => {
  it('[machine] preserves the INPUT order and resolves text + weight from the JD', () => {
    const views = resolveRequirements(['r3', 'r1'], JD_FIXTURE, LEDGER_FIXTURE);
    expect(views.map((v) => v.requirementId)).toEqual(['r3', 'r1']);
    expect(views[0].text).toBe('Payments or fintech domain experience');
    expect(views[0].weight).toBe(2);
    expect(views[1].weight).toBe(3);
  });

  it('[machine] collects ALL bindings for a requirement, not just the first', () => {
    // r1 carries two bindings; the scorer takes the strongest for the NUMBER, but the
    // drill-down must show every piece of evidence that was found.
    const [r1] = resolveRequirements(['r1'], JD_FIXTURE, LEDGER_FIXTURE);
    expect(r1.bindings).toHaveLength(2);
    expect(r1.bindings.map((b) => b.strength)).toEqual(['strong', 'partial']);
    expect(r1.gaps).toEqual([]);
  });

  it('[machine] attaches the gap for an unbound requirement', () => {
    const [r4] = resolveRequirements(['r4'], JD_FIXTURE, LEDGER_FIXTURE);
    expect(r4.bindings).toEqual([]);
    expect(r4.gaps).toHaveLength(1);
    expect(r4.gaps[0].probe).toMatch(/berlin office/i);
  });

  it('[machine] returns text/weight null for an id ABSENT from the JD — never drops it', () => {
    // FIT-02 counts hallucinated requirement ids in `anomalies` and never filters
    // them (plan E4). Dropping them here would violate "宁可暴露不完整，不静默吞掉".
    const views = resolveRequirements(['r1', 'ghost-id'], JD_FIXTURE, LEDGER_FIXTURE);
    expect(views).toHaveLength(2);
    expect(views[1]).toMatchObject({ requirementId: 'ghost-id', text: null, weight: null });
  });

  it('[machine] does not mutate its arguments', () => {
    const jdBefore = JSON.stringify(JD_FIXTURE);
    const ledgerBefore = JSON.stringify(LEDGER_FIXTURE);
    resolveRequirements(['r1', 'r2', 'r3'], JD_FIXTURE, LEDGER_FIXTURE);
    expect(JSON.stringify(JD_FIXTURE)).toBe(jdBefore);
    expect(JSON.stringify(LEDGER_FIXTURE)).toBe(ledgerBefore);
  });

  it('[machine] returns [] for no ids', () => {
    expect(resolveRequirements([], JD_FIXTURE, LEDGER_FIXTURE)).toEqual([]);
  });
});

describe('fit-view-model — isNotAssessed (FIT-02 D6, plan D7/§5 Q2)', () => {
  it('[machine] true ONLY when both arrays are empty', () => {
    expect(isNotAssessed(NOT_ASSESSED_SUB_SCORE)).toBe(true);
    expect(isNotAssessed({ score: 0, bindings: [], gaps: ['r4'] })).toBe(false);
    expect(isNotAssessed({ score: 0, bindings: ['r1'], gaps: [] })).toBe(false);
    expect(isNotAssessed({ score: 60, bindings: ['r1'], gaps: ['r5'] })).toBe(false);
  });

  it('[machine] §5 Q2: a bucket with gaps but NO bindings reports as ASSESSED (a real 0 shows)', () => {
    // This is the one case where the predicate FIT-02 prescribed and the scorer's own
    // composite-exclusion rule DISAGREE: evidenceStrength with zero bindings has
    // weightSum 0 (excluded from the composite) yet a non-empty informational `gaps`.
    // Pinned here so the disagreement is visible and deliberate rather than
    // discovered by a confused user during dogfooding.
    const evidenceStrengthWithNoBindings = { score: 0, bindings: [], gaps: ['r1', 'r2'] };
    expect(isNotAssessed(evidenceStrengthWithNoBindings)).toBe(false);
  });

  it('[machine] hasUnassessedBucket flags a report with any excluded bucket', () => {
    expect(hasUnassessedBucket(fitFixture())).toBe(false);
    expect(
      hasUnassessedBucket(
        fitFixture({
          subScores: {
            ...fitFixture().subScores,
            domain: { ...NOT_ASSESSED_SUB_SCORE },
          },
        }),
      ),
    ).toBe(true);
  });

  it('[machine] SUB_SCORE_KEYS/LABELS cover exactly FitReport.subScores', () => {
    expect(SUB_SCORE_KEYS.slice().sort()).toEqual(
      Object.keys(fitFixture().subScores).slice().sort(),
    );
    expect(Object.keys(SUB_SCORE_LABELS).slice().sort()).toEqual(SUB_SCORE_KEYS.slice().sort());
  });
});

describe('fit-view-model — dropped derivations (plan D8)', () => {
  it('[machine] uncoveredGaps counts ONLY gaps carrying the em-dash marker', () => {
    expect(uncoveredGaps(LEDGER_FIXTURE).map((g) => g.requirementId)).toEqual(['r5']);
    expect(uncoveredGaps(EMPTY_LEDGER_FIXTURE)).toEqual([]);
    // A gap whose probe merely CONTAINS the words is not a marker.
    expect(
      uncoveredGaps({
        bindings: [],
        gaps: [{ requirementId: 'r1', probe: 'is this uncovered — rerun worthy?', play: '' }],
      }),
    ).toEqual([]);
  });

  it('[machine] droppedFromLedger is ALWAYS partial and labels by requirement text', () => {
    const view = droppedFromLedger(LEDGER_FIXTURE, JD_FIXTURE);
    expect(view.partial).toBe(true);
    expect(view.count).toBe(1);
    expect(view.items).toHaveLength(1);
    expect(view.items[0].label).toBe('Terraform / infrastructure as code');
  });

  it('[machine] droppedFromLedger falls back to the raw id when the JD has no such requirement', () => {
    const view = droppedFromLedger(
      { bindings: [], gaps: [{ requirementId: 'ghost', probe: UNCOVERED_MARKER, play: '' }] },
      JD_FIXTURE,
    );
    expect(view.items[0].label).toBe('ghost');
  });

  it('[machine] droppedFromResponse is NOT partial and carries layer 1s raw discards', () => {
    const { dropped } = fitResponseFixture();
    const view = droppedFromResponse(dropped, JD_FIXTURE);

    expect(view.partial).toBe(false);
    // The count comes from the RESPONSE, not from re-counting the arrays — it is the
    // same number recorded in usage_events.droppedCount.
    expect(view.count).toBe(dropped.count);
    expect(view.items).toHaveLength(2);
    expect(view.items[0].detail).toContain('project-that-does-not-exist');
    expect(view.items[0].detail).toContain('Built an internal gRPC gateway');
    expect(view.items[1].label).toBe('Terraform / infrastructure as code');
  });

  it('[machine] both derivations survive an empty ledger / empty payload', () => {
    expect(droppedFromLedger(EMPTY_LEDGER_FIXTURE, EMPTY_JD_FIXTURE)).toEqual({
      count: 0,
      items: [],
      partial: true,
    });
    expect(
      droppedFromResponse({ count: 0, bindings: [], uncoveredRequirementIds: [] }, EMPTY_JD_FIXTURE),
    ).toEqual({ count: 0, items: [], partial: false });
  });
});
