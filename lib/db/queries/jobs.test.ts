import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import type { FitReport, JdExtract, Ledger } from '@/lib/schemas/pipeline';

// FIT-01 — the machine-checkable acceptance surface for lib/db/queries/jobs.ts.
//
// The module under test resolves its Drizzle client with `await import('@/db/index')`
// INSIDE each function (its build-time-safety rule), and db/index.ts THROWS at import
// time without DATABASE_URL. So the real db/index.ts must never load here: every
// access goes through a dynamic import() made AFTER vi.doMock('@/db/index', ...) has
// swapped in a PGlite-backed client (+ vi.resetModules() so the mock takes). Same
// pattern as lib/db/queries/library.test.ts.
//
// ONE PGlite for the whole file (beforeAll), with a FRESH crypto.randomUUID() userId
// per test for isolation — every query in the module under test is userId-scoped, so
// distinct users give full test-to-test isolation without truncating between tests.

// ISS-29: a PGlite boot + the real migration chain exceeds Vitest's 5000ms default
// under full-suite load. Passed as each it()'s THIRD ARGUMENT — the only placement
// Vitest actually binds (a task's timeout is resolved at COLLECTION time, so
// `vi.setConfig` inside a hook is a silent no-op). The last test guards the raise.
const PGLITE_TEST_TIMEOUT_MS = 30_000;

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

let db: TestDb;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema });
  // The real committed migration chain through drizzle's own migrator — the same
  // code path production runs, and the only thing that proves migration 0003's
  // DROP NOT NULL actually reached the live schema.
  await migrate(db, { migrationsFolder: './db/migrations' });
}, PGLITE_TEST_TIMEOUT_MS);

/** Loads a FRESH copy of the query module with `@/db/index` swapped for PGlite. */
async function importQueries(client: unknown = db) {
  vi.resetModules();
  vi.doMock('@/db/index', () => ({ db: client, dbTx: client }));
  return import('@/lib/db/queries/jobs');
}

async function freshUser() {
  const userId = crypto.randomUUID();
  await db.insert(schema.users).values({ id: userId, email: `${userId}@example.com` });
  return userId;
}

/** Forces a wall-clock gap: `$onUpdate` is client-side `Date.now()` (ms resolution). */
function clockGap() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

// --- Fixtures ----------------------------------------------------------------

function makeJd(overrides: Partial<JdExtract> = {}): JdExtract {
  return {
    requirements: [
      { id: 'r1', text: 'Production Kubernetes', weight: 3, category: 'technical' },
      { id: 'r2', text: '5+ years backend', weight: 2, category: 'experience' },
    ],
    atsKeywords: ['Kubernetes', 'Go'],
    subtext: ['on-call is likely reactive'],
    ...overrides,
  };
}

const LEDGER: Ledger = {
  bindings: [
    { requirementId: 'r1', projectId: 'voice-agent', strength: 'strong', evidence: 'ran EKS' },
  ],
  gaps: [{ requirementId: 'r2', probe: 'How long have you...', play: 'Bridge via depth' }],
};

function makeFit(compositeScore = 72): FitReport {
  const sub = { score: compositeScore, bindings: ['r1'], gaps: ['r2'] };
  return {
    hardRequirements: [{ label: 'visa', status: 'pass' }],
    subScores: {
      technical: sub,
      experienceDepth: sub,
      domain: sub,
      evidenceStrength: sub,
    },
    compositeScore,
    tier: 'Competitive',
    advice: 'Lead with the platform work.',
    topGaps: LEDGER.gaps,
  };
}

async function jobRows(jobId: string) {
  return db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
}

describe('lib/db/queries/jobs — createJob', () => {
  it(
    '[machine] creates a jd-only job: status screening, ledger/fit NULL, jd round-tripped (§0.1 R-A proof)',
    async () => {
      const { createJob } = await importQueries();
      const userId = await freshUser();
      const jd = makeJd();

      const before = Date.now();
      const job = await createJob(userId, 'Acme', 'Staff Engineer', 'We are hiring...', jd);

      expect(job.userId).toBe(userId);
      expect(job.company).toBe('Acme');
      expect(job.role).toBe('Staff Engineer');
      expect(job.jdRaw).toBe('We are hiring...');
      // The initial state is the funnel's first state and is NOT caller-supplied.
      expect(job.status).toBe('screening');
      // THIS is the direct machine proof of the §0.1 R-A amendment: the row exists
      // with neither ledger nor fit, which migration 0000's NOT NULL forbade.
      expect(job.ledger).toBeNull();
      expect(job.fit).toBeNull();
      expect(job.jd).toEqual(jd);
      // Server-generated identity and timestamps.
      expect(job.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(job.createdAt).toBeGreaterThanOrEqual(before);
      expect(job.updatedAt).toBeGreaterThanOrEqual(before);

      // ...and it really is in Postgres, not just in the returned object.
      const [row] = await jobRows(job.id);
      expect(row.ledger).toBeNull();
      expect(row.fit).toBeNull();
      expect(row.jd).toEqual(jd);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

describe('lib/db/queries/jobs — getJob', () => {
  it(
    '[machine] returns the row for its owner and null for an unknown id',
    async () => {
      const { createJob, getJob } = await importQueries();
      const userId = await freshUser();
      const created = await createJob(userId, 'Acme', 'Engineer', 'jd', makeJd());

      expect(await getJob(userId, created.id)).toEqual(created);
      expect(await getJob(userId, crypto.randomUUID())).toBeNull();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    "[machine] returns null — indistinguishably — for another user's real job (cross-user isolation, PRD §8.3)",
    async () => {
      const { createJob, getJob } = await importQueries();
      const owner = await freshUser();
      const attacker = await freshUser();
      const created = await createJob(owner, 'Acme', 'Engineer', 'jd', makeJd());

      const notYours = await getJob(attacker, created.id);
      const notFound = await getJob(attacker, crypto.randomUUID());

      // Byte-identical results: the caller has no oracle for "this id exists".
      expect(notYours).toBeNull();
      expect(notFound).toBeNull();
      expect(notYours).toEqual(notFound);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

describe('lib/db/queries/jobs — updateJobStatus', () => {
  it(
    '[machine] moves screening -> applied, bumps updatedAt, leaves createdAt untouched',
    async () => {
      const { createJob, updateJobStatus, getJob } = await importQueries();
      const userId = await freshUser();
      const created = await createJob(userId, 'Acme', 'Engineer', 'jd', makeJd());

      await clockGap();
      const updated = await updateJobStatus(userId, created.id, 'applied');

      expect(updated?.status).toBe('applied');
      expect(updated?.createdAt).toBe(created.createdAt);
      expect(updated?.updatedAt).toBeGreaterThan(created.updatedAt);
      // Persisted, not just returned.
      expect((await getJob(userId, created.id))?.status).toBe('applied');
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] accepts any of the four statuses from any current status (no ordering rule — PRD names none)',
    async () => {
      const { createJob, updateJobStatus } = await importQueries();
      const userId = await freshUser();
      const created = await createJob(userId, 'Acme', 'Engineer', 'jd', makeJd());

      // screening -> interviewing DIRECTLY: permissive by design (ticket Background).
      expect((await updateJobStatus(userId, created.id, 'interviewing'))?.status).toBe(
        'interviewing',
      );
      expect((await updateJobStatus(userId, created.id, 'screening'))?.status).toBe('screening');
      expect((await updateJobStatus(userId, created.id, 'closed'))?.status).toBe('closed');
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    "[machine] returns null for another user's job AND leaves that row untouched (no cross-user write)",
    async () => {
      const { createJob, updateJobStatus } = await importQueries();
      const owner = await freshUser();
      const attacker = await freshUser();
      const created = await createJob(owner, 'Acme', 'Engineer', 'jd', makeJd());

      expect(await updateJobStatus(attacker, created.id, 'closed')).toBeNull();

      const [row] = await jobRows(created.id);
      expect(row.status).toBe('screening');
      expect(row.updatedAt).toBe(created.updatedAt);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

describe('lib/db/queries/jobs — attachLedgerAndFit (FIT-02 s write)', () => {
  it(
    '[machine] fills ledger and fit together and returns the completed row',
    async () => {
      const { createJob, attachLedgerAndFit, getJob } = await importQueries();
      const userId = await freshUser();
      const created = await createJob(userId, 'Acme', 'Engineer', 'jd', makeJd());
      expect(created.ledger).toBeNull();

      const completed = await attachLedgerAndFit(userId, created.id, LEDGER, makeFit());

      expect(completed?.ledger).toEqual(LEDGER);
      expect(completed?.fit).toEqual(makeFit());
      // Status is NOT touched by the fit write — it stays where the funnel put it.
      expect(completed?.status).toBe('screening');

      const reread = await getJob(userId, created.id);
      expect(reread?.fit?.compositeScore).toBe(72);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] a second call OVERWRITES unconditionally (the v1 contract FIT-02 inherits)',
    async () => {
      const { createJob, attachLedgerAndFit } = await importQueries();
      const userId = await freshUser();
      const created = await createJob(userId, 'Acme', 'Engineer', 'jd', makeJd());

      await attachLedgerAndFit(userId, created.id, LEDGER, makeFit(72));
      const second = await attachLedgerAndFit(userId, created.id, LEDGER, makeFit(91));

      // No "already fitted" guard exists in v1 — deliberately left to FIT-02
      // (docs/plans/FIT-01.md §5 Q4). This test pins the behavior so a future guard
      // is a visible, reviewed change rather than a silent one.
      expect(second?.fit?.compositeScore).toBe(91);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    "[machine] returns null for another user's job AND leaves that row untouched",
    async () => {
      const { createJob, attachLedgerAndFit } = await importQueries();
      const owner = await freshUser();
      const attacker = await freshUser();
      const created = await createJob(owner, 'Acme', 'Engineer', 'jd', makeJd());

      expect(await attachLedgerAndFit(attacker, created.id, LEDGER, makeFit())).toBeNull();

      const [row] = await jobRows(created.id);
      expect(row.ledger).toBeNull();
      expect(row.fit).toBeNull();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

describe('lib/db/queries/jobs — stored-row drift', () => {
  it(
    '[machine] THROWS when the stored jd jsonb does not match JdExtract, and logs no field values',
    async () => {
      const { getJob } = await importQueries();
      const userId = await freshUser();

      // Raw insert of a drifted row (what a future schema change would leave behind).
      const [seeded] = await db
        .insert(schema.jobs)
        .values({
          userId,
          company: 'Acme',
          role: 'Engineer',
          status: 'screening',
          jdRaw: 'jd',
          // `weight: 7` is outside JdExtract's 1|2|3 union; `secretSalary` is the
          // canary that must never reach a log line.
          jd: {
            requirements: [
              { id: 'r1', text: 'secretSalary 250k', weight: 7, category: 'technical' },
            ],
            atsKeywords: [],
            subtext: [],
          } as unknown as JdExtract,
        })
        .returning();

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(getJob(userId, seeded.id)).rejects.toThrow(/PersistedJob/);

        const logged = JSON.stringify(errorSpy.mock.calls);
        expect(logged).toContain('requirements.0.weight'); // issue PATHS are useful
        expect(logged).not.toContain('secretSalary'); // ...values never are
      } finally {
        errorSpy.mockRestore();
      }
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

// --- FIT-03 append ------------------------------------------------------------

describe('lib/db/queries/jobs — listJobs (FIT-03, plan D1)', () => {
  it(
    "[machine] returns ONLY the caller's rows — another user's jobs are invisible (PRD §8.3)",
    async () => {
      const { createJob, listJobs } = await importQueries();
      const owner = await freshUser();
      const other = await freshUser();

      const mine = await createJob(owner, 'Acme', 'Engineer', 'jd', makeJd());
      await createJob(other, 'Globex', 'Engineer', 'jd', makeJd());

      const rows = await listJobs(owner);
      expect(rows.map((r) => r.id)).toEqual([mine.id]);
      // ...and the other user still sees exactly their own.
      expect((await listJobs(other)).map((r) => r.company)).toEqual(['Globex']);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] orders by createdAt DESC (newest first), NOT by updatedAt',
    async () => {
      const { createJob, listJobs, updateJobStatus } = await importQueries();
      const userId = await freshUser();

      // `createdAt` is set explicitly rather than relying on insertion order:
      // $defaultFn timestamps are Date.now() at ms resolution and three inserts in
      // one test can collide, which would make the assertion pass or fail by luck.
      const oldest = await createJob(userId, 'Oldest', 'Engineer', 'jd', makeJd());
      const middle = await createJob(userId, 'Middle', 'Engineer', 'jd', makeJd());
      const newest = await createJob(userId, 'Newest', 'Engineer', 'jd', makeJd());
      await db.update(schema.jobs).set({ createdAt: 1_000 }).where(eq(schema.jobs.id, oldest.id));
      await db.update(schema.jobs).set({ createdAt: 2_000 }).where(eq(schema.jobs.id, middle.id));
      await db.update(schema.jobs).set({ createdAt: 3_000 }).where(eq(schema.jobs.id, newest.id));

      expect((await listJobs(userId)).map((r) => r.company)).toEqual([
        'Newest',
        'Middle',
        'Oldest',
      ]);

      // Touching the OLDEST job's status bumps its updatedAt to "now" — if the
      // ordering key were updatedAt it would jump to the top. It must not.
      await clockGap();
      await updateJobStatus(userId, oldest.id, 'applied');
      expect((await listJobs(userId)).map((r) => r.company)).toEqual([
        'Newest',
        'Middle',
        'Oldest',
      ]);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] returns [] for a user with no jobs',
    async () => {
      const { listJobs } = await importQueries();
      expect(await listJobs(await freshUser())).toEqual([]);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] returns EXACTLY the five JobListRow keys — no jdRaw/jd/ledger/fit (plan D1)',
    async () => {
      // THIS is the test that keeps D1 true against a future "just select *" edit:
      // the narrow projection is a privacy and blast-radius decision, and a widened
      // select would silently undo it with no other visible symptom.
      const { createJob, listJobs } = await importQueries();
      const userId = await freshUser();
      await createJob(userId, 'Acme', 'Engineer', 'SECRET JD TEXT', makeJd());

      const [row] = await listJobs(userId);
      expect(Object.keys(row).sort()).toEqual([
        'company',
        'createdAt',
        'id',
        'role',
        'status',
      ]);
      const widened = row as Record<string, unknown>;
      expect(widened.jdRaw).toBeUndefined();
      expect(widened.jd).toBeUndefined();
      expect(widened.ledger).toBeUndefined();
      expect(widened.fit).toBeUndefined();
      expect(JSON.stringify(row)).not.toContain('SECRET JD TEXT');
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] includes a FIT-LESS job — the transient post-FIT-01/pre-FIT-02 row must be listed',
    async () => {
      // A narrow projection cannot see `fit`, so this is really a statement about
      // what the list must NOT do: filter to "complete" jobs. The user has already
      // paid a `fit` quota unit for this row; hiding it would hide their money.
      const { createJob, listJobs } = await importQueries();
      const userId = await freshUser();
      const created = await createJob(userId, 'Acme', 'Engineer', 'jd', makeJd());
      expect(created.fit).toBeNull();

      const rows = await listJobs(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: created.id, status: 'screening' });
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

describe('lib/db/queries/jobs — module safety', () => {
  // BUILD GUARD. FIT-03's server components import this module DIRECTLY, and
  // `next build`'s "Collecting page data" phase imports every page module — while
  // db/index.ts throws at import time without DATABASE_URL. Every other test here
  // mocks `@/db/index` and would therefore MASK a static import.
  it(
    '[machine] the module imports cleanly with DATABASE_URL unset and nothing mocked',
    async () => {
      vi.stubEnv('DATABASE_URL', '');
      try {
        vi.resetModules();
        vi.doUnmock('@/db/index');

        await expect(import('@/lib/db/queries/jobs')).resolves.toBeDefined();
        // Sanity: the module that WOULD have blown up really does, so this test
        // cannot pass merely because DATABASE_URL happened to be set.
        await expect(import('@/db/index')).rejects.toThrow(/DATABASE_URL/);
      } finally {
        vi.unstubAllEnvs();
      }
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  // ISS-29 guard, mirroring lib/db/queries/library.test.ts: reads the timeout Vitest
  // actually BOUND and fails if the raise ever stops taking effect.
  it('[machine] ISS-29 guard: every test in this file got the raised PGlite timeout bound', ({
    task,
  }) => {
    type AnyTask = { type: string; name: string; timeout: number; tasks?: AnyTask[] };
    const flatten = (tasks: AnyTask[]): AnyTask[] =>
      tasks.flatMap((t) => (t.type === 'suite' ? flatten(t.tasks ?? []) : [t]));
    const allTests = flatten((task.file?.tasks ?? []) as unknown as AnyTask[]).filter(
      (t) => t.type === 'test',
    );
    expect(allTests.length).toBeGreaterThanOrEqual(11);
    const notRaised = allTests
      .filter((t) => t.timeout < PGLITE_TEST_TIMEOUT_MS)
      .map((t) => t.name)
      // This guard itself makes no DB call and needs no raise.
      .filter((name) => !name.includes('ISS-29 guard'));
    expect(notRaised).toEqual([]);
  });
});
