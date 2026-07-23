import type { Library } from '@/lib/schemas/entities';
import type { Brief } from '@/lib/schemas/persisted';
import type { Intel, Ledger, Rehearse, RehearseQuestion } from '@/lib/schemas/pipeline';

// PRP-04 — TEST-ONLY fixtures (plan §2.6). Mirrors app/(app)/jobs/_fixtures/job-fixtures.ts
// and resume/_fixtures/tailored-fixtures.ts conventions EXACTLY: HAND-WRITTEN LITERALS ONLY —
// no `node:fs`, no `@/eval` import, no `import.meta.url` (all of which throw at import under
// Vitest's jsdom environment). Only TYPE imports of pure schema types; nothing here drags
// drizzle. No production module imports this file, and `_`-prefixed folders are Next.js
// private (never routed).

const JOB_ID = 'job-1';

/**
 * A library with THREE projects (kebab-case ids satisfying Project.id's regex) so the
 * question-grouping test (acceptance item 4) can span three distinct angles. `ghost-project`
 * is deliberately ABSENT so the raw-id fallback (plan D10) can be exercised.
 */
export const LIBRARY_FIXTURE: Library = {
  profile: {
    name: 'Ada Lovelace',
    headline: 'Platform engineer',
    contact: { email: 'ada@example.com', links: [] },
  },
  projects: [
    {
      id: 'voice-agent',
      name: 'Voice Agent',
      stage: 'shipped',
      role: 'Tech lead',
      stack: ['Go', 'Kubernetes'],
      summary: 'Real-time voice routing on EKS; chose gRPC streaming over REST for latency.',
      metrics: ['2.1M calls/day', '40-node cluster'],
      tags: ['infra'],
    },
    {
      id: 'billing-migration',
      name: 'Billing Migration',
      stage: 'shipped',
      role: 'Backend engineer',
      stack: ['Postgres', 'Go'],
      summary: 'Migrated a card-billing ledger table by table with dual-writes and no downtime.',
      metrics: ['zero downtime'],
      tags: ['payments'],
    },
    {
      id: 'search-ranking',
      name: 'Search Ranking',
      stage: 'shipped',
      role: 'Backend engineer',
      stack: ['Python', 'Elasticsearch'],
      summary: 'Rebuilt the ranking pipeline; traded recall for p99 latency on the hot path.',
      metrics: ['p99 120ms'],
      tags: ['search'],
    },
  ],
};

/**
 * A non-empty Intel: a snapshot, two `recent` items (each headline carries the "(Mon YYYY)"
 * source-date suffix per PRP-01 D9c + a `soWhat`), and populated engineeringSignals /
 * talkingPoints. `.max(3)` on each array is respected.
 */
export const INTEL_FIXTURE: Intel = {
  snapshot:
    'Northwind Payments is a Series C card-processing platform migrating its ledger off a legacy monolith.',
  recent: [
    {
      headline: 'Announced a real-time fraud-scoring product (Mar 2026).',
      soWhat: 'They are hiring for latency-sensitive backend work — lead with your p99 story.',
    },
    {
      headline: 'Hired a new VP of Engineering from a large fintech (Jan 2026).',
      soWhat: 'Expect a stronger emphasis on operational rigour and on-call maturity.',
    },
  ],
  engineeringSignals: ['Go + gRPC on the core services', 'Kubernetes on EKS'],
  talkingPoints: ['Ask how far the ledger migration has progressed'],
};

/**
 * The explicit "查无实据" state (PRD §5.1 RESEARCH: "查无实据返回空数组，禁止编造"): a
 * snapshot with every array empty. The intel card must render the snapshot and NO empty
 * lists, and must not crash.
 */
export const EMPTY_INTEL_FIXTURE: Intel = {
  snapshot: 'Little public engineering information is available for this company.',
  recent: [],
  engineeringSignals: [],
  talkingPoints: [],
};

/**
 * FIVE questions spanning THREE distinct `projectId`s present in LIBRARY_FIXTURE
 * (voice-agent ×2, billing-migration ×2, search-ranking ×1) — the grouping test asserts
 * exactly three group headers. Every `trap` is non-empty (FND-03's `RehearseQuestion.trap`
 * is `.min(1)`).
 */
export const REHEARSE_FIXTURE: Rehearse = {
  questions: [
    {
      projectId: 'voice-agent',
      question: 'How did you keep the voice routing latency low at 2.1M calls a day?',
      trap: 'What happened to tail latency when a node was cordoned during a deploy?',
    },
    {
      projectId: 'voice-agent',
      question: 'Why gRPC streaming over REST for the routing hot path?',
      trap: 'Where did gRPC cost you — say, in debuggability or client support?',
    },
    {
      projectId: 'billing-migration',
      question: 'Walk me through the dual-write cutover on the billing ledger.',
      trap: 'How did you prove the two ledgers agreed before the final switch?',
    },
    {
      projectId: 'billing-migration',
      question: 'How did you achieve zero downtime on the migration?',
      trap: 'What would you have done differently if a backfill had corrupted a row?',
    },
    {
      projectId: 'search-ranking',
      question: 'You traded recall for p99 latency — how did you decide the cut-off?',
      trap: 'How did you measure the business cost of the recall you gave up?',
    },
  ],
  askThem: [
    'How far along is the ledger migration, and what is still on the monolith?',
    'What does on-call look like for the core payments services today?',
    'How does the team decide when a latency regression blocks a release?',
  ],
  positioning:
    'Position yourself as the engineer who ships latency-critical backend systems and can reason about the payments-integrity tradeoffs this team is living through.',
};

/**
 * A ledger with two bindings (the "strengths" count) and two gaps, each gap carrying a
 * non-empty `probe`/`play` for the brief's ledger recap (plan D11).
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
      requirementId: 'r2',
      projectId: 'billing-migration',
      strength: 'partial',
      evidence: 'Migrated a card-billing ledger without downtime',
    },
  ],
  gaps: [
    {
      requirementId: 'r3',
      probe: 'Have you owned a service through a formal incident-review process?',
      play: 'Bridge from the billing cutover: describe the runbook and rollback you prepared.',
    },
    {
      requirementId: 'r4',
      probe: 'Do you have direct fraud-detection experience?',
      play: 'Be honest that it is adjacent, then connect it to your ranking-pipeline work.',
    },
  ],
};

/**
 * A persisted `Brief` (jobId, intel, rehearse, createdAt, updatedAt), built from the fixtures
 * above. Default `intel` is INTEL_FIXTURE; pass `{ intel: null }` for the degraded-research
 * brief that must render the research-fail banner.
 */
export function briefFixture(overrides: Partial<Brief> = {}): Brief {
  return {
    jobId: JOB_ID,
    intel: INTEL_FIXTURE,
    rehearse: REHEARSE_FIXTURE,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    ...overrides,
  };
}

/**
 * A dropped question citing a projectId NOT in LIBRARY_FIXTURE — the exact
 * referential-integrity discard PRP-02's route makes (§5.5 layer 1). Held out so callers can
 * reuse it.
 */
const DROPPED_QUESTION: RehearseQuestion = {
  projectId: 'ghost-project',
  question: 'Tell me about the ghost project you never built.',
  trap: 'And how did that imaginary project scale?',
};

/**
 * PRP-02's exact 200 body: the persisted Brief at the TOP LEVEL plus the additive `dropped`
 * key (plan §2.6 / Deliverable 6). `dropped` exists ONLY in this response — it is never
 * persisted, so the reload path never sees it.
 */
export function rehearseResponseFixture(overrides: Record<string, unknown> = {}) {
  return {
    ...briefFixture(),
    dropped: {
      count: 1,
      questions: [{ item: DROPPED_QUESTION, reason: 'projectId not in library' }],
    },
    ...overrides,
  };
}

/**
 * PRP-01's 200 body: `{ intel, failed }`. Default is the happy path; the degraded shape the
 * degrade-not-block test uses is `{ intel: null, failed: true }`.
 */
export function researchResponseFixture(overrides: Record<string, unknown> = {}) {
  return {
    intel: INTEL_FIXTURE,
    failed: false,
    ...overrides,
  };
}
