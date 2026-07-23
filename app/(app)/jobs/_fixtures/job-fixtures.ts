import type { JobListRow, PersistedJob } from '@/lib/db/queries/jobs';
import type {
  FitReport,
  Gap,
  JdExtract,
  Ledger,
  SubScore,
} from '@/lib/schemas/pipeline';
import { UNCOVERED_MARKER } from '@/lib/validation';

// FIT-03 — TEST-ONLY fixtures (docs/plans/FIT-03.md D16). No production module may
// import this file, and `_`-prefixed folders are Next.js PRIVATE folders, so nothing
// here is ever routed.
//
// HAND-WRITTEN LITERALS ONLY — no `node:fs`, no `@/eval` import, no
// `import.meta.url`. That is not a style preference: LIB-03's own fixture header
// records that `@/eval/fixtures` THROWS AT IMPORT TIME under Vitest's jsdom
// environment (`import.meta.url` is not a `file://` URL there, so its top-level
// `fileURLToPath(new URL(...))` dies). Most of this ticket's tests are jsdom.
//
// `PersistedJob` and `JobListRow` are imported as TYPES ONLY. A value import of
// `@/lib/db/queries/jobs` would drag `drizzle-orm` and `@/db/schema` into a jsdom
// test (and, if a production file ever copied the import, into the client bundle).
// `UNCOVERED_MARKER` IS a value import and that is safe: `@/lib/validation`'s barrel
// and all four of its modules import nothing but types (verified).
//
// THE NUMBERS BELOW ARE NOT DECORATIVE. `FIT_FIXTURE`'s sub-scores and composite are
// what `lib/scoring/score.ts` ACTUALLY produces from `JD_FIXTURE` + `LEDGER_FIXTURE`
// — derived by hand from its documented formula and re-derivable from the comment on
// each field. A fixture whose numbers could not come out of the real scorer would
// make every component test green against a report shape that never occurs.
//
// `fit-view-model.test.ts` safeParses every fixture here against FND-03's schemas, so
// a schema drift shows up as a failing fixture rather than as green tests asserting
// nothing.

// --- READ output --------------------------------------------------------------

/**
 * Six requirements exercising ALL FOUR `RequirementCategory` values (including
 * `logistics`, which by FIT-02's D5 joins no sub-score bucket) and all three weights.
 * Stable ids `r1`…`r6` so every downstream fixture can reference them by hand.
 */
export const JD_FIXTURE: JdExtract = {
  requirements: [
    { id: 'r1', text: 'Production Kubernetes at scale', weight: 3, category: 'technical' },
    { id: 'r2', text: '5+ years building backend services', weight: 2, category: 'experience' },
    { id: 'r3', text: 'Payments or fintech domain experience', weight: 2, category: 'domain' },
    { id: 'r4', text: 'Based in Berlin or willing to relocate', weight: 1, category: 'logistics' },
    { id: 'r5', text: 'Terraform / infrastructure as code', weight: 1, category: 'technical' },
    { id: 'r6', text: 'gRPC service design', weight: 1, category: 'technical' },
  ],
  atsKeywords: ['Kubernetes', 'Go', 'Terraform', 'gRPC'],
  subtext: ['on-call is likely reactive', 'the team is newly formed'],
};

// --- CROSS output ---------------------------------------------------------------

/**
 * r1/r2/r3 bound, r4/r6 genuine gaps, r5 an INJECTED layer-2 gap.
 *
 * r1 deliberately carries TWO bindings (one `strong`, one `partial`) so the scorer's
 * "a requirement carrying several bindings is scored by its STRONGEST one" rule is
 * representable, and so the drill-down has a requirement with more than one piece of
 * evidence to render.
 *
 * The r5 gap is what FND-07's layer 2 injects for a requirement the model covered in
 * neither array: `probe === UNCOVERED_MARKER` and `play: ''` BY DESIGN. Rendering an
 * empty "your bridge" bullet for it is the exact trap plan D13 exists to close, so it
 * must be present in the fixture rather than invented per-test.
 */
export const LEDGER_FIXTURE: Ledger = {
  bindings: [
    {
      requirementId: 'r1',
      projectId: 'voice-agent',
      strength: 'strong',
      evidence: 'Ran a 40-node EKS cluster serving 2.1M calls/day',
    },
    {
      requirementId: 'r1',
      projectId: 'billing-migration',
      strength: 'partial',
      evidence: 'Operated the staging cluster during the cutover',
    },
    {
      requirementId: 'r2',
      projectId: 'billing-migration',
      strength: 'partial',
      evidence: '3 years on the payments backend team',
    },
    {
      requirementId: 'r3',
      projectId: 'billing-migration',
      strength: 'partial',
      evidence: 'Migrated a card-billing ledger without downtime',
    },
  ],
  gaps: [
    {
      requirementId: 'r4',
      probe: 'Are you able to work from the Berlin office?',
      play: 'Say plainly that you are already planning the move, and give your date.',
    },
    // The layer-2 injection. `play` is '' by FND-07 design — do not "fix" it.
    { requirementId: 'r5', probe: UNCOVERED_MARKER, play: '' },
    {
      requirementId: 'r6',
      probe: 'How would you design a gRPC service boundary?',
      play: 'Bridge from your REST API versioning work and name the trade-off you hit.',
    },
  ],
};

/** The two `Gap`s a caller most often wants by hand. */
export const UNCOVERED_GAP_FIXTURE: Gap = LEDGER_FIXTURE.gaps[1];
export const NORMAL_GAP_FIXTURE: Gap = LEDGER_FIXTURE.gaps[0];

// --- SCORE output ---------------------------------------------------------------

/** D7's "not assessed" shape: FIT-02's D6 encodes it as both arrays empty. */
export const NOT_ASSESSED_SUB_SCORE: SubScore = { score: 0, bindings: [], gaps: [] };

/** Its assessed counterpart — the technical bucket below. */
export const ASSESSED_SUB_SCORE: SubScore = { score: 60, bindings: ['r1'], gaps: ['r5', 'r6'] };

/**
 * The `advice` string for the base tier, copied VERBATIM from
 * `lib/scoring/score.ts`'s ADVICE_BY_TIER (which is module-private there, so this is
 * a copy rather than an import). If that table ever changes, this string is stale —
 * which is fine for a fixture, and is why nothing asserts equality between the two.
 */
const COMPETITIVE_ADVICE =
  'Competitive. You cover most of what this posting screens on — close the top gaps below before you apply.';

/**
 * A `FitReport` builder, so a per-tier test differs from the base by ONE line.
 *
 * Every number is what `computeFitReport(LEDGER_FIXTURE, JD_FIXTURE, …)` produces:
 *   technical         r1(w3,strong→1) + r5(w1,gap→0) + r6(w1,gap→0) = 3/5   → 60
 *   experienceDepth   r2(w2,partial→0.5)                            = 1/2   → 50
 *   domain            r3(w2,partial→0.5)                            = 1/2   → 50
 *   evidenceStrength  bound r1,r2,r3: (3·1 + 2·0.5 + 2·0.5)/7       = 5/7   → 71
 *                     (r4/r5/r6 are listed in its `gaps` INFORMATIONALLY and do not
 *                      enter its weightSum — FIT-02's D4 asymmetry)
 *   composite         (60+50+50+71)/4 = 57.75                               → 58
 *   tier              58 ∈ [55,74]                                → 'Competitive'
 *   topGaps           unbound r4/r5/r6, all weight 1, so JD order: r4, r5, r6
 */
export function fitFixture(overrides: Partial<FitReport> = {}): FitReport {
  return {
    hardRequirements: [
      { label: 'Work authorisation (EU)', status: 'pass' },
      { label: 'Location: Berlin', status: 'fail' },
      { label: 'German language', status: 'unknown' },
    ],
    subScores: {
      technical: { score: 60, bindings: ['r1'], gaps: ['r5', 'r6'] },
      experienceDepth: { score: 50, bindings: ['r2'], gaps: [] },
      domain: { score: 50, bindings: ['r3'], gaps: [] },
      evidenceStrength: { score: 71, bindings: ['r1', 'r2', 'r3'], gaps: ['r4', 'r5', 'r6'] },
    },
    compositeScore: 58,
    tier: 'Competitive',
    advice: COMPETITIVE_ADVICE,
    topGaps: [LEDGER_FIXTURE.gaps[0], LEDGER_FIXTURE.gaps[1], LEDGER_FIXTURE.gaps[2]],
    ...overrides,
  };
}

/**
 * PRD §4/§5.5's degenerate case, and a real one: a zero-requirement `JdExtract` is
 * schema-legal (`.max(11)` only) and FIT-02 short-circuits it to an all-empty report.
 * Every renderer must survive it — all four cards "Not assessed", no callout, no
 * division by zero.
 */
export const EMPTY_JD_FIXTURE: JdExtract = { requirements: [], atsKeywords: [], subtext: [] };
export const EMPTY_LEDGER_FIXTURE: Ledger = { bindings: [], gaps: [] };
export function emptyFitFixture(): FitReport {
  return {
    hardRequirements: [],
    subScores: {
      technical: { ...NOT_ASSESSED_SUB_SCORE },
      experienceDepth: { ...NOT_ASSESSED_SUB_SCORE },
      domain: { ...NOT_ASSESSED_SUB_SCORE },
      evidenceStrength: { ...NOT_ASSESSED_SUB_SCORE },
    },
    compositeScore: 0,
    tier: 'Long shot',
    advice:
      'Long shot. Your library does not cover most of what this posting screens on. If you still apply, prioritise the top gaps below.',
    topGaps: [],
  };
}

// --- Persisted rows -------------------------------------------------------------

const JOB_ID = 'job-1';

/**
 * A COMPLETE job (post-FIT-02). Pass `{ ledger: null, fit: null }` for the transient
 * post-FIT-01/pre-FIT-02 row that drives the auto-runner branch.
 */
export function jobFixture(overrides: Partial<PersistedJob> = {}): PersistedJob {
  return {
    id: JOB_ID,
    userId: 'user-abc-123',
    company: 'Northwind Payments',
    role: 'Staff Platform Engineer',
    status: 'screening',
    jdRaw: 'CONFIDENTIAL-JD-BODY: we are hiring a staff platform engineer…',
    jd: JD_FIXTURE,
    ledger: LEDGER_FIXTURE,
    fit: fitFixture(),
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    ...overrides,
  };
}

/**
 * FOUR rows, ONE PER `JobStatus`, so the list test covers all four chips from data
 * instead of hardcoding four literals. `createdAt` descends, matching `listJobs`'s
 * own ordering so a test can assert render order against the fixture directly.
 */
export const JOB_LIST_FIXTURE: JobListRow[] = [
  {
    id: 'job-screening',
    company: 'Northwind Payments',
    role: 'Staff Platform Engineer',
    status: 'screening',
    createdAt: 1_700_000_400_000,
  },
  {
    id: 'job-applied',
    company: 'Globex',
    role: 'Backend Engineer',
    status: 'applied',
    createdAt: 1_700_000_300_000,
  },
  {
    id: 'job-interviewing',
    company: 'Initech',
    role: 'Site Reliability Engineer',
    status: 'interviewing',
    createdAt: 1_700_000_200_000,
  },
  {
    id: 'job-closed',
    company: 'Umbrella',
    role: 'Infrastructure Lead',
    status: 'closed',
    createdAt: 1_700_000_100_000,
  },
];

// --- FIT-02's 200 body ----------------------------------------------------------

/**
 * The EXACT shape `POST /api/jobs/[id]/fit` returns on success: the completed job at
 * the TOP LEVEL plus the two additive keys `dropped` and `anomalies` (that route's
 * own wire contract, transcribed).
 *
 * `dropped.bindings` is the only place layer-1's raw discarded entries EVER exist —
 * nothing persists them (plan D8 / §5 Q3), which is precisely why the fresh-fit path
 * and the reload path render different amounts of detail.
 */
export function fitResponseFixture(overrides: Record<string, unknown> = {}) {
  return {
    ...jobFixture(),
    dropped: {
      count: 2,
      bindings: [
        {
          item: {
            requirementId: 'r6',
            projectId: 'project-that-does-not-exist',
            strength: 'partial' as const,
            evidence: 'Built an internal gRPC gateway',
          },
          reason: 'projectId not in library',
        },
      ],
      uncoveredRequirementIds: ['r5'],
    },
    anomalies: { doubleCoveredRequirementIds: [], unknownRequirementIds: [] },
    ...overrides,
  };
}
