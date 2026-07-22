import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import type { UsageOp } from '@/lib/schemas/persisted';

// PLT-03 — integration tests for the /admin aggregation queries, run against a
// real Postgres (PGlite = Postgres compiled to WASM) with the REAL committed
// migration chain, i.e. the same code path production runs.
//
// ISS-29: PGlite boot + the migration chain exceeds Vitest's 5000ms default under
// full-suite load. The raise MUST be passed as the third argument to beforeAll and
// to EVERY it() — a task's timeout is resolved and closed over at COLLECTION time,
// so a vi.setConfig()/vi.useFakeTimers() inside a hook is a silent no-op. That is
// the exact bug ISS-29 had to bounce-fix.
const PGLITE_TEST_TIMEOUT_MS = 30_000;

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
type AdminQueries = typeof import('@/lib/db/queries/admin');

let client: PGlite;
let db: TestDb;
let q: AdminQueries;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './db/migrations' });

  // The module under test resolves '@/db/index' LAZILY (its own build-time-safety
  // requirement), and the real one throws without DATABASE_URL — so swap in the
  // PGlite-backed client. admin.ts needs only the `db` export: it reads only.
  vi.resetModules();
  vi.doMock('@/db/index', () => ({ db }));
  q = await import('@/lib/db/queries/admin');
}, PGLITE_TEST_TIMEOUT_MS);

// TRUNCATE between tests. This is the single most important difference from the
// userId-scoped query tests elsewhere in this repo: those get isolation for free
// because each test mints a fresh user, but THESE AGGREGATIONS ARE GLOBAL — rows
// seeded by test A change test B's expected numbers. Without this, tests pass
// alone and fail as a suite (or worse, pass now and silently break when someone
// adds a test later). A fresh PGlite per test would cost ~1.5s each, which is
// what ISS-29 was filed about.
beforeEach(async () => {
  await client.exec(
    'truncate table users, libraries, resumes, jobs, tailored_resumes, briefs, usage_events restart identity cascade;',
  );
});

// --- Fixtures ----------------------------------------------------------------
// jobs / tailored_resumes / briefs carry NOT NULL jsonb columns; these minimal
// Zod-valid literals are copied from app/api/account/delete/route.test.ts rather
// than reinvented.
const jd = { requirements: [], atsKeywords: ['k8s'], subtext: [] };
const ledger = { bindings: [], gaps: [] };
const subScore = { score: 80, bindings: [], gaps: [] };
const fit = {
  hardRequirements: [{ label: 'visa', status: 'pass' as const }],
  subScores: {
    technical: subScore,
    experienceDepth: subScore,
    domain: subScore,
    evidenceStrength: subScore,
  },
  compositeScore: 78,
  tier: 'Strong' as const,
  advice: 'Lead with the realtime work.',
  topGaps: [],
};
const alignment = [{ keyword: 'k8s', status: 'present' as const }];
const edit = {
  original: 'Worked on backend.',
  suggested: 'Led the streaming-ASR backend.',
  rationale: 'Adds a metric.',
  projectId: 'voice-agent',
};
const rehearse = {
  questions: Array.from({ length: 5 }, () => ({
    projectId: 'voice-agent',
    question: 'Why barge-in?',
    trap: 'And the echo-cancellation cost?',
  })),
  askThem: ['a', 'b', 'c'],
  positioning: 'A realtime-systems engineer.',
};
const profile = { name: 'Ada Lovelace' };
const project = {
  id: 'voice-agent',
  name: 'Voice Agent',
  stage: 'shipped',
  role: 'Tech lead',
  stack: ['TypeScript'],
  summary: 'Streaming ASR + LLM orchestration.',
  metrics: ['12k MAU'],
  tags: ['llm'],
};

// A FIXED instant, passed explicitly as nowMs, so the 7-day-window boundary
// assertions are exact rather than racing the wall clock.
const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

async function seedUser(id: string) {
  await db.insert(schema.users).values({ id, email: `${id}@example.com` });
  return id;
}

type EventSeed = {
  createdAt: number;
  costUsd?: number;
  durationMs?: number;
  droppedCount?: number;
  op?: UsageOp;
};

async function seedEvents(userId: string, events: EventSeed[]) {
  if (events.length === 0) return;
  await db.insert(schema.usageEvents).values(
    events.map((e) => ({
      userId,
      op: e.op ?? ('parse' as const),
      tokensIn: 0,
      tokensOut: 0,
      searches: 0,
      costUsd: e.costUsd ?? 0,
      durationMs: e.durationMs ?? 0,
      droppedCount: e.droppedCount ?? 0,
      createdAt: e.createdAt,
    })),
  );
}

// -----------------------------------------------------------------------------

describe('getWeeklyCost (acceptance 1: 7-day window)', () => {
  it('[machine] sums ONLY rows inside the last 7 days, with an INCLUSIVE lower bound', async () => {
    const userId = await seedUser('u-cost');
    await seedEvents(userId, [
      { createdAt: NOW, costUsd: 0.1 }, // in
      { createdAt: NOW - 1_000, costUsd: 0.02 }, // in
      { createdAt: NOW - WEEK_MS, costUsd: 0.005 }, // in — bound is >=
      { createdAt: NOW - WEEK_MS - 1, costUsd: 99.0 }, // out, by 1ms
      { createdAt: NOW - 30 * DAY_MS, costUsd: 42.0 }, // out
    ]);

    // toBeCloseTo, not toBe: numeric arrives as a string and is coerced through
    // float, so 0.1 + 0.02 + 0.005 is not bit-exact.
    await expect(q.getWeeklyCost(NOW)).resolves.toBeCloseTo(0.125, 10);
  }, PGLITE_TEST_TIMEOUT_MS);

  it('[machine] returns exactly 0 (not NaN, not null) over an empty table', async () => {
    const total = await q.getWeeklyCost(NOW);
    expect(total).toBe(0);
    expect(Number.isNaN(total)).toBe(false);
  }, PGLITE_TEST_TIMEOUT_MS);

  it('[machine] defaults nowMs to Date.now() when called with no argument (the ticket signature)', async () => {
    const userId = await seedUser('u-cost-default');
    await seedEvents(userId, [
      { createdAt: Date.now(), costUsd: 0.25 },
      { createdAt: Date.now() - WEEK_MS - 60_000, costUsd: 7.0 },
    ]);
    await expect(q.getWeeklyCost()).resolves.toBeCloseTo(0.25, 10);
  }, PGLITE_TEST_TIMEOUT_MS);
});

describe('getLatencyPercentiles (acceptance 2: deterministic p50/p95)', () => {
  it('[machine] computes nearest-rank p50/p95 per op and windows per op', async () => {
    const userId = await seedUser('u-lat');
    await seedEvents(userId, [
      // parse: 10 in-window rows, 100..1000 → p50 = rank ceil(.5*10)=5 → 500,
      //                                        p95 = rank ceil(.95*10)=10 → 1000
      ...Array.from({ length: 10 }, (_, i) => ({
        createdAt: NOW - i,
        durationMs: (i + 1) * 100,
        op: 'parse' as const,
      })),
      // tailor: 3 in-window rows, 100/200/300 → p50 = rank 2 → 200, p95 = rank 3 → 300
      { createdAt: NOW, durationMs: 100, op: 'tailor' as const },
      { createdAt: NOW, durationMs: 200, op: 'tailor' as const },
      { createdAt: NOW, durationMs: 300, op: 'tailor' as const },
      // cross: one row 1ms OUTSIDE the window → the op must fall back to zeroes
      { createdAt: NOW - WEEK_MS - 1, durationMs: 9_999, op: 'cross' as const },
    ]);

    const result = await q.getLatencyPercentiles(NOW);

    expect(result.parse).toEqual({ p50: 500, p95: 1000, samples: 10 });
    expect(result.tailor).toEqual({ p50: 200, p95: 300, samples: 3 });
    expect(result.cross).toEqual({ p50: 0, p95: 0, samples: 0 });
    expect(result.read).toEqual({ p50: 0, p95: 0, samples: 0 });
    expect(result.research).toEqual({ p50: 0, p95: 0, samples: 0 });
    expect(result.rehearse).toEqual({ p50: 0, p95: 0, samples: 0 });
  }, PGLITE_TEST_TIMEOUT_MS);

  it('[machine] returns a COMPLETE record keyed by exactly the six UsageOp values', async () => {
    const result = await q.getLatencyPercentiles(NOW);
    expect(Object.keys(result).sort()).toEqual(
      ['cross', 'parse', 'read', 'rehearse', 'research', 'tailor'].sort(),
    );
  }, PGLITE_TEST_TIMEOUT_MS);

  it('[machine] returns real numbers, not driver strings (the .mapWith(Number) guard, R8)', async () => {
    // An un-mapped raw sql<number> returns numbers under PGlite and STRINGS under
    // @neondatabase/serverless — green tests, string math in production. A loose
    // equality assertion would not catch it; typeof does.
    const userId = await seedUser('u-lat-types');
    await seedEvents(userId, [
      { createdAt: NOW, durationMs: 700, op: 'read' as const },
      { createdAt: NOW, durationMs: 900, op: 'read' as const },
    ]);

    const result = await q.getLatencyPercentiles(NOW);
    expect(typeof result.read.p50).toBe('number');
    expect(typeof result.read.p95).toBe('number');
    expect(typeof result.read.samples).toBe('number');
    expect(result.read).toEqual({ p50: 700, p95: 900, samples: 2 });
  }, PGLITE_TEST_TIMEOUT_MS);
});

describe('getDroppedRate', () => {
  it('[machine] divides dropped items by in-window events (0.75) — the R7 integer-division guard', async () => {
    const userId = await seedUser('u-drop');
    await seedEvents(userId, [
      { createdAt: NOW, droppedCount: 3 },
      { createdAt: NOW, droppedCount: 0 },
      { createdAt: NOW, droppedCount: 0 },
      { createdAt: NOW, droppedCount: 0 },
      { createdAt: NOW - WEEK_MS - 1, droppedCount: 100 }, // out of window
    ]);

    // An SQL-side sum(dropped)/count(*) is bigint/bigint and would TRUNCATE this
    // to 0. This exact value is the regression guard.
    await expect(q.getDroppedRate(NOW)).resolves.toBeCloseTo(0.75, 10);
  }, PGLITE_TEST_TIMEOUT_MS);

  it('[machine] returns 0 over an empty table WITHOUT raising a division-by-zero', async () => {
    await expect(q.getDroppedRate(NOW)).resolves.toBe(0);
  }, PGLITE_TEST_TIMEOUT_MS);

  it('[machine] returns 0 when every in-window event dropped nothing', async () => {
    const userId = await seedUser('u-drop-zero');
    await seedEvents(userId, [
      { createdAt: NOW, droppedCount: 0 },
      { createdAt: NOW, droppedCount: 0 },
      { createdAt: NOW, droppedCount: 0 },
    ]);
    await expect(q.getDroppedRate(NOW)).resolves.toBe(0);
  }, PGLITE_TEST_TIMEOUT_MS);
});

describe('getFunnelConversion (acceptance 3: hand-computed ratios)', () => {
  // Seeds the exact dataset from the plan §3.1(d) whose three expected ratios are
  // hand-computable: 0.25 / 0.25 / 0.5.
  async function seedFunnel() {
    for (const id of ['u1', 'u2', 'u3', 'u4']) await seedUser(id);

    // libraries: u1 has a real one; u2's is empty; u3's is soft-deleted; u4 has none.
    await db.insert(schema.libraries).values([
      { userId: 'u1', profile, projects: [project], createdAt: NOW, updatedAt: NOW },
      { userId: 'u2', profile, projects: [], createdAt: NOW, updatedAt: NOW },
      {
        userId: 'u3',
        profile,
        projects: [project],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: NOW,
      },
    ]);

    const job = (id: string, userId: string, status: 'screening' | 'interviewing' | 'closed') => ({
      id,
      userId,
      company: 'Acme',
      role: 'Staff Engineer',
      status,
      jdRaw: 'We are hiring...',
      jd,
      ledger,
      fit,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(schema.jobs).values([
      job('j1', 'u1', 'screening'),
      job('j2', 'u1', 'interviewing'),
      job('j3', 'u2', 'interviewing'),
      job('j4', 'u3', 'closed'),
    ]);

    await db.insert(schema.tailoredResumes).values({
      jobId: 'j1',
      alignment,
      edits: [edit],
      fullDraftMd: '# Ada',
      createdAt: NOW,
      updatedAt: NOW,
    });

    // A brief on j2 (interviewing) AND on j4 (closed). The j4 row is what proves
    // the status filter lives on the JOBS side — counting briefs alone would
    // wrongly include it.
    await db.insert(schema.briefs).values([
      { jobId: 'j2', rehearse, createdAt: NOW, updatedAt: NOW },
      { jobId: 'j4', rehearse, createdAt: NOW, updatedAt: NOW },
    ]);
  }

  it('[machine] matches the hand-computed ratios (0.25 / 0.25 / 0.5)', async () => {
    await seedFunnel();
    const funnel = await q.getFunnelConversion();

    // 4 users; only u1 has a non-deleted library with a non-empty projects array.
    expect(funnel.signupToLibrary).toBeCloseTo(0.25, 10);
    // 4 jobs (jobs.fit is NOT NULL, so every job counts); 1 has a tailored resume.
    expect(funnel.fitToTailor).toBeCloseTo(0.25, 10);
    // interviewing jobs = {j2, j3} = 2; of those, {j2} has a brief.
    expect(funnel.interviewingToBrief).toBeCloseTo(0.5, 10);
  }, PGLITE_TEST_TIMEOUT_MS);

  it('[machine] a DUPLICATE libraries row for one user does not inflate the ratio (countDistinct guard)', async () => {
    await seedFunnel();
    // libraries.userId has no UNIQUE constraint — two concurrent confirms can
    // produce two rows. Counting rows instead of distinct users would give 2/4.
    await db.insert(schema.libraries).values({
      userId: 'u1',
      profile,
      projects: [project],
      createdAt: NOW,
      updatedAt: NOW,
    });

    const funnel = await q.getFunnelConversion();
    expect(funnel.signupToLibrary).toBeCloseTo(0.25, 10);
  }, PGLITE_TEST_TIMEOUT_MS);

  it('[machine] returns all three ratios as exactly 0 on an empty database (no division by zero)', async () => {
    await expect(q.getFunnelConversion()).resolves.toEqual({
      signupToLibrary: 0,
      fitToTailor: 0,
      interviewingToBrief: 0,
    });
  }, PGLITE_TEST_TIMEOUT_MS);

  it('[machine] returns only numbers — no rows, emails, ids or other identifying data (R6)', async () => {
    await seedFunnel();
    const funnel = await q.getFunnelConversion();
    expect(Object.values(funnel).every((v) => typeof v === 'number')).toBe(true);
    expect(JSON.stringify(funnel)).not.toMatch(/@example\.com/);
  }, PGLITE_TEST_TIMEOUT_MS);
});

describe('module-level invariants', () => {
  it('[machine] all four functions run concurrently through ONE lazy @/db/index import (R11)', async () => {
    // The page calls exactly this shape. Without the memoized dbIndex(), vitest's
    // mocker re-resolves the specifier per import() and one of the same-tick
    // racers gets the REAL @/db/index, which throws on the DATABASE_URL fail-fast.
    const userId = await seedUser('u-concurrent');
    await seedEvents(userId, [{ createdAt: NOW, costUsd: 1.5, durationMs: 10, droppedCount: 1 }]);

    const [cost, latency, dropped, funnel] = await Promise.all([
      q.getWeeklyCost(NOW),
      q.getLatencyPercentiles(NOW),
      q.getDroppedRate(NOW),
      q.getFunnelConversion(),
    ]);

    expect(cost).toBeCloseTo(1.5, 10);
    expect(latency.parse).toEqual({ p50: 10, p95: 10, samples: 1 });
    expect(dropped).toBe(1);
    expect(funnel.signupToLibrary).toBe(0);
  }, PGLITE_TEST_TIMEOUT_MS);

  it('[machine] ISS-29 guard: every test in this file got the raised PGlite timeout bound', ({
    task,
  }) => {
    // The raise must be the third argument to it() — a task's timeout is bound at
    // COLLECTION time, so vi.setConfig() inside a hook is a silent no-op. This
    // walks the whole file's task tree so a new PGlite test added without the
    // argument fails loudly instead of flaking under load.
    const walk = (tasks: readonly { type: string; name: string; timeout?: number; tasks?: readonly unknown[] }[]): string[] =>
      tasks.flatMap((t) =>
        t.type === 'suite'
          ? walk((t.tasks ?? []) as never)
          : (t.timeout ?? 0) < PGLITE_TEST_TIMEOUT_MS
            ? [`${t.name} (${t.timeout}ms)`]
            : [],
      );

    const root = task.file;
    const all = walk((root?.tasks ?? []) as never);
    expect(all).toEqual([]);
  }, PGLITE_TEST_TIMEOUT_MS);
});
