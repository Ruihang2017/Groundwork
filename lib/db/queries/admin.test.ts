import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import type { Project } from '@/lib/schemas/entities';
import {
  getDroppedRate,
  getFunnelConversion,
  getLatencyPercentiles,
  getWeeklyCost,
  WEEK_MS,
  type Executor,
} from '@/lib/db/queries/admin';

// PLT-03 — the machine-checkable acceptance surface for lib/db/queries/admin.ts.
//
// The module under test is imported STATICALLY here, unlike lib/db/queries/
// library.test.ts's resetModules+doMock dance. That is itself a regression guard:
// this file would fail to load at all if admin.ts ever grew a top-level
// `@/db/index` import (db/index.ts throws without DATABASE_URL, which the test
// env does not set) — the single most likely implementation mistake in this
// ticket, and the one that breaks `pnpm build` on a clean checkout. The queries
// receive their client through the additive `executor` option. ONE test
// deliberately goes through the production lazy-import path instead (see
// "lazy @/db/index resolution").
//
// ISOLATION IS THE TRAP HERE. Unlike library.test.ts, whose queries are all
// userId-scoped so a fresh crypto.randomUUID() user gives isolation for free,
// every query in this module is GLOBAL: any row any test seeds is visible to
// every other test's counts. So: one PGlite for the file, and an explicit
// TRUNCATE ... CASCADE of every table before each test. Do NOT reintroduce
// "distinct user ids give isolation" reasoning — that is exactly the assumption
// this module breaks.
//
// ISS-29: a PGlite boot + the real migration chain exceeds Vitest's 5000ms
// default under full-suite load. Passed as each hook's/test's THIRD ARGUMENT
// because that is the only placement Vitest actually binds (a task's timeout is
// closed over at COLLECTION time, so vi.setConfig inside a hook is a silent
// no-op).
const PGLITE_TEST_TIMEOUT_MS = 30_000;

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

let db: TestDb;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema });
  // The real committed migration through drizzle's own migrator — the same code
  // path production runs (db/migrate.test.ts Tier 3).
  await migrate(db, { migrationsFolder: './db/migrations' });
}, PGLITE_TEST_TIMEOUT_MS);

beforeEach(async () => {
  await db.execute(
    sql`truncate table usage_events, tailored_resumes, briefs, jobs, resumes, libraries, users restart identity cascade`,
  );
}, PGLITE_TEST_TIMEOUT_MS);

/** The injected client, typed as the module's public Executor. */
function exec(): Executor {
  return db as unknown as Executor;
}

// A FIXED clock for every windowed assertion: `now` is passed explicitly so
// boundary cases are exact instead of racing the wall clock, and so a slow CI box
// cannot drift a row out of the window mid-test.
const NOW = 1_700_000_000_000;

// --- Fixtures (Zod-valid nested jsonb; same construction style as
// app/api/account/delete/route.test.ts:48-90, because jobs.jd/ledger/fit,
// libraries.profile, briefs.rehearse and tailored_resumes.alignment/edits/
// fullDraftMd are all NOT NULL). ------------------------------------------------
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

async function seedUser(): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(schema.users).values({ id, email: `${id}@example.com` });
  return id;
}

type EventOverrides = {
  op?: (typeof schema.usageOpEnum.enumValues)[number];
  costUsd?: number;
  durationMs?: number;
  droppedCount?: number;
  createdAt?: number;
};

async function seedEvent(userId: string, o: EventOverrides = {}) {
  await db.insert(schema.usageEvents).values({
    userId,
    op: o.op ?? 'read',
    tokensIn: 100,
    tokensOut: 200,
    searches: 0,
    costUsd: o.costUsd ?? 0,
    durationMs: o.durationMs ?? 1000,
    droppedCount: o.droppedCount ?? 0,
    createdAt: o.createdAt ?? NOW,
  });
}

async function seedJob(
  userId: string,
  status: (typeof schema.jobStatusEnum.enumValues)[number] = 'screening',
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(schema.jobs).values({
    id,
    userId,
    company: 'Acme',
    role: 'Staff Engineer',
    status,
    jdRaw: 'We are hiring...',
    jd,
    ledger,
    fit,
  });
  return id;
}

async function seedLibrary(
  userId: string,
  opts: { projects?: Project[]; deletedAt?: number } = {},
) {
  await db.insert(schema.libraries).values({
    userId,
    profile,
    projects: opts.projects ?? [project],
    deletedAt: opts.deletedAt,
  });
}

async function seedTailoredResume(jobId: string) {
  await db
    .insert(schema.tailoredResumes)
    .values({ jobId, alignment, edits: [edit], fullDraftMd: '# Ada Lovelace' });
}

async function seedBrief(jobId: string) {
  await db.insert(schema.briefs).values({ jobId, rehearse });
}

// =============================================================================
describe('getWeeklyCost (acceptance item 1)', () => {
  it(
    'sums ONLY events inside the rolling 7-day window, boundary INCLUSIVE',
    async () => {
      const userId = await seedUser();
      await seedEvent(userId, { costUsd: 0.25, createdAt: NOW - 60 * 60 * 1000 }); // 1h ago: IN
      await seedEvent(userId, { costUsd: 0.5, createdAt: NOW - WEEK_MS }); // exactly 7d: IN (>=)
      await seedEvent(userId, { costUsd: 10, createdAt: NOW - WEEK_MS - 1 }); // 1ms older: OUT
      await seedEvent(userId, { costUsd: 100, createdAt: NOW - 30 * 24 * 3600_000 }); // OUT

      expect(await getWeeklyCost({ executor: exec(), now: NOW })).toBeCloseTo(0.75, 10);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'returns a NUMBER, not the string drizzle sum() maps to (driver-coercion guard)',
    async () => {
      const userId = await seedUser();
      await seedEvent(userId, { costUsd: 0.25, createdAt: NOW });
      await seedEvent(userId, { costUsd: 0.5, createdAt: NOW });

      const total = await getWeeklyCost({ executor: exec(), now: NOW });
      // Without Number(), string concatenation would give "0.250.50" here.
      expect(typeof total).toBe('number');
      expect(total).toBeCloseTo(0.75, 10);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'returns 0 (never NaN/null) for an empty window and an empty table',
    async () => {
      expect(await getWeeklyCost({ executor: exec(), now: NOW })).toBe(0);

      const userId = await seedUser();
      await seedEvent(userId, { costUsd: 5, createdAt: NOW - WEEK_MS - 1 });
      const onlyStale = await getWeeklyCost({ executor: exec(), now: NOW });
      expect(onlyStale).toBe(0);
      expect(Number.isNaN(onlyStale)).toBe(false);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'defaults `now` to the wall clock when no option is passed (the ticket signature)',
    async () => {
      const userId = await seedUser();
      await seedEvent(userId, { costUsd: 2, createdAt: Date.now() - 1000 });
      await seedEvent(userId, { costUsd: 99, createdAt: Date.now() - WEEK_MS - 60_000 });

      expect(await getWeeklyCost({ executor: exec() })).toBeCloseTo(2, 10);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

// =============================================================================
describe('getLatencyPercentiles (acceptance item 2)', () => {
  it(
    'computes percentile_cont p50/p95 per op over hand-seeded durations',
    async () => {
      const userId = await seedUser();
      // percentile_cont over sorted x[0..N-1]: pos = p*(N-1),
      // x[⌊pos⌋] + (pos-⌊pos⌋)*(x[⌈pos⌉]-x[⌊pos⌋]).
      // [10,20,30,40]: p50 pos=1.5 → 20+0.5*10 = 25; p95 pos=2.85 → 30+0.85*10 = 38.5.
      for (const durationMs of [10, 20, 30, 40]) {
        await seedEvent(userId, { op: 'read', durationMs, createdAt: NOW - 1000 });
      }
      // A single sample: both percentiles are that value.
      await seedEvent(userId, { op: 'cross', durationMs: 100, createdAt: NOW - 1000 });

      const result = await getLatencyPercentiles({ executor: exec(), now: NOW });
      expect(result.read.p50).toBeCloseTo(25, 10);
      expect(result.read.p95).toBeCloseTo(38.5, 10);
      expect(result.cross).toEqual({ p50: 100, p95: 100 });
      expect(typeof result.read.p50).toBe('number');
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'returns a COMPLETE record over all six UsageOp values; ops with no events are {0,0}',
    async () => {
      const userId = await seedUser();
      await seedEvent(userId, { op: 'tailor', durationMs: 500, createdAt: NOW });

      const result = await getLatencyPercentiles({ executor: exec(), now: NOW });
      expect(Object.keys(result).sort()).toEqual([...schema.usageOpEnum.enumValues].sort());
      expect(Object.keys(result)).toHaveLength(6);
      expect(result.tailor).toEqual({ p50: 500, p95: 500 });
      for (const op of ['parse', 'read', 'cross', 'research', 'rehearse'] as const) {
        expect(result[op], op).toEqual({ p50: 0, p95: 0 });
      }
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'ignores events outside the window, however extreme',
    async () => {
      const userId = await seedUser();
      for (const durationMs of [10, 20, 30, 40]) {
        await seedEvent(userId, { op: 'read', durationMs, createdAt: NOW - 1000 });
      }
      await seedEvent(userId, {
        op: 'read',
        durationMs: 9_999_999,
        createdAt: NOW - WEEK_MS - 1,
      });

      const result = await getLatencyPercentiles({ executor: exec(), now: NOW });
      expect(result.read.p50).toBeCloseTo(25, 10);
      expect(result.read.p95).toBeCloseTo(38.5, 10);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'returns every op as {0,0} when there are no events at all',
    async () => {
      const result = await getLatencyPercentiles({ executor: exec(), now: NOW });
      expect(Object.values(result).every((v) => v.p50 === 0 && v.p95 === 0)).toBe(true);
      expect(Object.keys(result)).toHaveLength(6);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

// =============================================================================
describe('getDroppedRate', () => {
  it(
    'is SUM(droppedCount) / COUNT(*) over the window — dropped items PER EVENT',
    async () => {
      const userId = await seedUser();
      for (const droppedCount of [0, 1, 2, 0]) {
        await seedEvent(userId, { droppedCount, createdAt: NOW - 1000 });
      }
      expect(await getDroppedRate({ executor: exec(), now: NOW })).toBeCloseTo(0.75, 10);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'excludes out-of-window events from BOTH numerator and denominator',
    async () => {
      const userId = await seedUser();
      for (const droppedCount of [0, 1, 2, 0]) {
        await seedEvent(userId, { droppedCount, createdAt: NOW - 1000 });
      }
      await seedEvent(userId, { droppedCount: 1000, createdAt: NOW - WEEK_MS - 1 });
      expect(await getDroppedRate({ executor: exec(), now: NOW })).toBeCloseTo(0.75, 10);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'returns 0 (never NaN) for an empty window — 0/0 must not divide',
    async () => {
      const empty = await getDroppedRate({ executor: exec(), now: NOW });
      expect(empty).toBe(0);
      expect(Number.isNaN(empty)).toBe(false);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'does not truncate to an integer the way a bigint/bigint SQL division would',
    async () => {
      const userId = await seedUser();
      // 1 dropped over 4 events = 0.25; Postgres integer division would give 0.
      await seedEvent(userId, { droppedCount: 1, createdAt: NOW });
      for (let i = 0; i < 3; i++) await seedEvent(userId, { droppedCount: 0, createdAt: NOW });
      expect(await getDroppedRate({ executor: exec(), now: NOW })).toBeCloseTo(0.25, 10);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

// =============================================================================
describe('getFunnelConversion (acceptance item 3)', () => {
  it(
    'signupToLibrary = users with a non-empty, not-deleted library / registered users',
    async () => {
      // The ticket's own worked example: 4 users, 1 with a library ⇒ 0.25.
      const withProjects = await seedUser();
      const withEmptyLibrary = await seedUser();
      const withDeletedLibrary = await seedUser();
      await seedUser(); // no library row at all

      await seedLibrary(withProjects);
      await seedLibrary(withEmptyLibrary, { projects: [] }); // empty ⇒ not counted
      await seedLibrary(withDeletedLibrary, { deletedAt: NOW }); // soft-deleted ⇒ not counted

      const funnel = await getFunnelConversion({ executor: exec() });
      expect(funnel.signupToLibrary).toBeCloseTo(0.25, 10);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'signupToLibrary counts a user ONCE even with duplicate library rows (no UNIQUE constraint exists)',
    async () => {
      const userId = await seedUser();
      await seedUser();
      await seedLibrary(userId);
      await seedLibrary(userId); // the duplicate two concurrent confirms could create

      const funnel = await getFunnelConversion({ executor: exec() });
      expect(funnel.signupToLibrary).toBeCloseTo(0.5, 10);
      expect(funnel.signupToLibrary).toBeLessThanOrEqual(1);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'fitToTailor = distinct jobs with a tailored resume / all jobs (every job has a fit by construction)',
    async () => {
      const userId = await seedUser();
      const tailored = await seedJob(userId);
      await seedJob(userId);
      await seedJob(userId);
      await seedJob(userId);

      await seedTailoredResume(tailored);
      await seedTailoredResume(tailored); // a re-tailor must NOT double-count

      const funnel = await getFunnelConversion({ executor: exec() });
      expect(funnel.fitToTailor).toBeCloseTo(0.25, 10);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'interviewingToBrief counts only jobs CURRENTLY in status "interviewing", on both sides',
    async () => {
      const userId = await seedUser();
      const interviewingWithBrief = await seedJob(userId, 'interviewing');
      await seedJob(userId, 'interviewing'); // interviewing, no brief
      const closedWithBrief = await seedJob(userId, 'closed');
      await seedJob(userId, 'screening');
      await seedJob(userId, 'applied');

      await seedBrief(interviewingWithBrief);
      await seedBrief(closedWithBrief); // must count in NEITHER numerator nor denominator

      const funnel = await getFunnelConversion({ executor: exec() });
      expect(funnel.interviewingToBrief).toBeCloseTo(0.5, 10);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'counts an interviewing job with several briefs only once',
    async () => {
      const userId = await seedUser();
      const jobId = await seedJob(userId, 'interviewing');
      await seedJob(userId, 'interviewing');
      await seedBrief(jobId);
      await seedBrief(jobId);

      const funnel = await getFunnelConversion({ executor: exec() });
      expect(funnel.interviewingToBrief).toBeCloseTo(0.5, 10);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'returns {0,0,0} — never NaN — on a completely empty database (day-one production state)',
    async () => {
      const funnel = await getFunnelConversion({ executor: exec() });
      expect(funnel).toEqual({
        signupToLibrary: 0,
        fitToTailor: 0,
        interviewingToBrief: 0,
      });
      for (const value of Object.values(funnel)) expect(Number.isNaN(value)).toBe(false);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'computes all three ratios together against one hand-computed dataset',
    async () => {
      const a = await seedUser();
      const b = await seedUser();
      await seedLibrary(a);
      await seedLibrary(b, { projects: [] });

      const jobA = await seedJob(a, 'interviewing');
      const jobB = await seedJob(a, 'interviewing');
      const jobC = await seedJob(b, 'screening');
      await seedTailoredResume(jobA);
      await seedTailoredResume(jobC);
      await seedBrief(jobB);

      const funnel = await getFunnelConversion({ executor: exec() });
      expect(funnel.signupToLibrary).toBeCloseTo(1 / 2, 10); // 1 of 2 users
      expect(funnel.fitToTailor).toBeCloseTo(2 / 3, 10); // 2 of 3 jobs
      expect(funnel.interviewingToBrief).toBeCloseTo(1 / 2, 10); // 1 of 2 interviewing
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

// =============================================================================
describe('module structure — build-time safety, concurrency, and the privacy boundary', () => {
  it('is importable with DATABASE_URL UNSET (no top-level @/db/index import — `pnpm build` guard)', async () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      vi.resetModules();
      const mod = await import('@/lib/db/queries/admin');
      expect(typeof mod.getWeeklyCost).toBe('function');
      expect(typeof mod.getLatencyPercentiles).toBe('function');
      expect(typeof mod.getDroppedRate).toBe('function');
      expect(typeof mod.getFunnelConversion).toBe('function');
    } finally {
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
      vi.resetModules();
    }
  });

  it(
    'resolves @/db/index lazily and only ONCE under same-tick concurrency (the page calls all four in one Promise.all)',
    async () => {
      // The production code path: no `executor` injected, so every function must
      // reach its client through the memoized dbIndex(). Vitest's mocker
      // re-resolves a doMock-ed specifier on EVERY import() call, so without the
      // memo one of these four would load the real @/db/index and die on its
      // DATABASE_URL fail-fast.
      const userId = await seedUser();
      // Real wall-clock timestamp: this path takes no `now` option, so the rows
      // must fall inside the live 7-day window.
      await seedEvent(userId, {
        costUsd: 1.5,
        durationMs: 42,
        droppedCount: 1,
        createdAt: Date.now(),
      });
      await seedLibrary(userId);

      let imports = 0;
      vi.resetModules();
      vi.doMock('@/db/index', () => {
        imports += 1;
        return { db, dbTx: db };
      });
      try {
        const mod = await import('@/lib/db/queries/admin');
        const [cost, latency, dropped, funnel] = await Promise.all([
          mod.getWeeklyCost(),
          mod.getLatencyPercentiles(),
          mod.getDroppedRate(),
          mod.getFunnelConversion(),
        ]);
        expect(cost).toBeCloseTo(1.5, 10);
        expect(latency.read.p50).toBeCloseTo(42, 10);
        expect(dropped).toBeCloseTo(1, 10);
        expect(funnel.signupToLibrary).toBeCloseTo(1, 10);
        expect(imports).toBe(1);
      } finally {
        vi.doUnmock('@/db/index');
        vi.resetModules();
      }
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'exposes NO function taking a userId, and returns NUMBERS ONLY — aggregates, structurally (PRD §8.3 exception)',
    async () => {
      // Arity ≤ 1: every exported query takes at most one optional options bag,
      // so none of them can have grown a `userId` positional. (An optional TS
      // parameter still counts toward Function.length, hence ≤ 1, not 0.)
      for (const fn of [
        getWeeklyCost,
        getLatencyPercentiles,
        getDroppedRate,
        getFunnelConversion,
      ]) {
        expect(fn.length, fn.name).toBeLessThanOrEqual(1);
      }

      // And nothing identifying can come back: seed a user with an email, a
      // library, a job and an event, then assert every returned value is a plain
      // number. No row, no id, no email — the mechanical half of header rule 2.
      const userId = await seedUser();
      await seedEvent(userId, { costUsd: 1, durationMs: 10, createdAt: NOW });
      await seedLibrary(userId);
      await seedJob(userId, 'interviewing');

      const [cost, latency, dropped, funnel] = await Promise.all([
        getWeeklyCost({ executor: exec(), now: NOW }),
        getLatencyPercentiles({ executor: exec(), now: NOW }),
        getDroppedRate({ executor: exec(), now: NOW }),
        getFunnelConversion({ executor: exec() }),
      ]);

      expect(typeof cost).toBe('number');
      expect(typeof dropped).toBe('number');
      for (const value of Object.values(funnel)) expect(typeof value).toBe('number');
      for (const [op, value] of Object.entries(latency)) {
        expect(Object.keys(value).sort(), op).toEqual(['p50', 'p95']);
        expect(typeof value.p50).toBe('number');
        expect(typeof value.p95).toBe('number');
      }
      // Belt: the whole serialized result must not contain the seeded user id or
      // an email-shaped string.
      const serialized = JSON.stringify({ cost, latency, dropped, funnel });
      expect(serialized).not.toContain(userId);
      expect(serialized).not.toMatch(/[\w.+-]+@[\w-]+\.\w+/);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it('is imported by EXACTLY ONE source file — app/(admin)/admin/page.tsx (cross-user queries must not leak)', () => {
    const roots = ['app', 'lib'];
    const importers: string[] = [];

    function walk(dir: string) {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.next') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        if (/\.test\.(ts|tsx)$/.test(entry)) continue; // this file, and any future test
        const source = readFileSync(full, 'utf8');
        if (source.includes("from '@/lib/db/queries/admin'")) {
          importers.push(full.replace(/\\/g, '/'));
        }
      }
    }

    for (const root of roots) walk(root);
    expect(importers.sort()).toEqual([
      'app/(admin)/admin/_components/observability-dashboard.tsx', // TYPES ONLY (import type)
      'app/(admin)/admin/page.tsx',
    ]);
    // The dashboard's reference is a type-only import, erased at compile time —
    // it executes no query. Verify that stays true.
    const dashboard = readFileSync(
      'app/(admin)/admin/_components/observability-dashboard.tsx',
      'utf8',
    );
    expect(dashboard).toContain("import type { FunnelConversion, OpLatency } from '@/lib/db/queries/admin'");
  });
});
