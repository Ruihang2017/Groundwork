import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { Rehearse } from '@/lib/schemas/pipeline';
import type { FitReport, Intel, JdExtract, Ledger, RehearseQuestion } from '@/lib/schemas/pipeline';

// PRP-02 — the machine-checkable acceptance surface for lib/db/queries/briefs.ts.
//
// The module under test resolves its Drizzle client with `await import('@/db/index')`
// INSIDE each function (its build-time-safety rule), and db/index.ts THROWS at import
// time without DATABASE_URL. So the real module must never load here: every access goes
// through a dynamic import() made AFTER vi.doMock('@/db/index', ...) has swapped in a
// PGlite-backed client (+ vi.resetModules() so the mock takes). Same pattern as
// lib/db/queries/tailored-resumes.test.ts.
//
// ONE PGlite for the whole file (beforeAll), with a FRESH crypto.randomUUID() userId (and
// a fresh job row) per test for isolation. `briefs.jobId` is an FK, so each test seeds a
// real users row and a real (fitted) jobs row first.

// ISS-29: a PGlite boot + the real migration chain exceeds Vitest's 5000ms default under
// full-suite load. Passed as each it()'s THIRD ARGUMENT — the only placement Vitest
// actually binds (a task's timeout resolves at COLLECTION time, so vi.setConfig in a hook
// is a silent no-op). The last test guards that the raise stays in force.
const PGLITE_TEST_TIMEOUT_MS = 30_000;

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

let db: TestDb;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './db/migrations' });
}, PGLITE_TEST_TIMEOUT_MS);

async function importQueries(client: unknown = db) {
  vi.resetModules();
  vi.doMock('@/db/index', () => ({ db: client, dbTx: client }));
  return import('@/lib/db/queries/briefs');
}

async function seedUser(userId: string) {
  await db.insert(schema.users).values({ id: userId, email: `${userId}@example.com` });
  return userId;
}

async function freshUser() {
  return seedUser(crypto.randomUUID());
}

const JD: JdExtract = {
  requirements: [
    { id: 'r1', text: 'Operate Kubernetes in production', weight: 3, category: 'technical' },
  ],
  atsKeywords: ['Kubernetes'],
  subtext: [],
};

const LEDGER: Ledger = { bindings: [], gaps: [] };

const FIT: FitReport = {
  hardRequirements: [],
  subScores: {
    technical: { score: 42, bindings: [], gaps: [] },
    experienceDepth: { score: 42, bindings: [], gaps: [] },
    domain: { score: 42, bindings: [], gaps: [] },
    evidenceStrength: { score: 42, bindings: [], gaps: [] },
  },
  compositeScore: 42,
  tier: 'Stretch',
  advice: 'seeded advice',
  topGaps: [],
};

/** A real fitted jobs row for `userId`; returns its id. */
async function seedJob(userId: string): Promise<string> {
  const [row] = await db
    .insert(schema.jobs)
    .values({
      userId,
      company: 'Acme',
      role: 'Staff SWE',
      status: 'interviewing',
      jdRaw: 'We are hiring.',
      jd: JD,
      ledger: LEDGER,
      fit: FIT,
    })
    .returning();
  return row.id;
}

function question(overrides: Partial<RehearseQuestion> = {}): RehearseQuestion {
  return {
    projectId: 'voice-agent',
    question: 'Walk me through how you sharded the ASR pipeline by session id.',
    trap: 'What did autoscaling NOT fix, and what did you change in the sharding key?',
    ...overrides,
  };
}

/** A schema-valid Rehearse (exactly 5 questions, exactly 3 askThem, non-empty traps). */
function validRehearse(): Rehearse {
  return {
    questions: [
      question({ projectId: 'voice-agent' }),
      question({ projectId: 'compiler' }),
      question({ projectId: 'voice-agent' }),
      question({ projectId: 'compiler' }),
      question({ projectId: 'voice-agent' }),
    ],
    askThem: [
      'How far through the Rails-to-Go migration is the team the candidate would join?',
      'What is still on the monolith today?',
      'Which service owns the p99 budget the JD mentions?',
    ],
    positioning: 'Lead with the latency work; bridge the on-call gap via the incident review.',
  };
}

const INTEL: Intel = {
  snapshot: 'Acme is a Series C dev-tools company.',
  recent: [{ headline: 'Raised a $90M Series C (Mar 2026)', soWhat: 'Scaling fast.' }],
  engineeringSignals: ['Moving from a Rails monolith to Go (2025).'],
  talkingPoints: ['How has CI cold-start held up as you grew?'],
};

async function briefRows(jobId: string) {
  return db.select().from(schema.briefs).where(eq(schema.briefs.jobId, jobId));
}

/** Forces a wall-clock gap: `$onUpdate` is client-side ms-resolution `Date.now()`. */
function clockGap() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

describe('lib/db/queries/briefs', () => {
  // [Test 1 / insert path] round-trips intel + rehearse jsonb; parsed value has no id.
  it(
    '[machine] upsertBrief inserts a row; getBrief reads it back, round-tripping intel + rehearse jsonb',
    async () => {
      const { upsertBrief, getBrief } = await importQueries();
      const userId = await freshUser();
      const jobId = await seedJob(userId);

      const returned = await upsertBrief(jobId, INTEL, validRehearse());
      expect(returned.jobId).toBe(jobId);
      expect(returned.intel).toEqual(INTEL);
      expect(returned.rehearse).toEqual(validRehearse());
      expect(typeof returned.createdAt).toBe('number');
      expect(typeof returned.updatedAt).toBe('number');

      const read = await getBrief(userId, jobId);
      expect(read).not.toBeNull();
      // jsonb does not preserve key order — compare parsed objects, never JSON strings.
      expect(read!.intel).toEqual(INTEL);
      expect(read!.rehearse).toEqual(validRehearse());
      // The parsed value carries no `id` column (Brief has no `id` field).
      expect('id' in (read as object)).toBe(false);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  // [Test 2 / D13 overwrite] one row per jobId; a re-run replaces the prior brief.
  it(
    '[machine] a second upsertBrief for the same jobId OVERWRITES in place (one row, updatedAt bumped, createdAt kept)',
    async () => {
      const { upsertBrief, getBrief } = await importQueries();
      const userId = await freshUser();
      const jobId = await seedJob(userId);

      await upsertBrief(jobId, INTEL, validRehearse());
      const [first] = await briefRows(jobId);

      await clockGap();
      const second = validRehearse();
      second.positioning = 'A completely different positioning paragraph.';
      await upsertBrief(jobId, null, second);

      const rows = await briefRows(jobId);
      expect(rows).toHaveLength(1); // overwrite, not append

      const read = await getBrief(userId, jobId);
      expect(read!.rehearse.positioning).toBe('A completely different positioning paragraph.');
      expect(read!.intel).toBeNull(); // the second write cleared intel

      expect(rows[0].id).toBe(first.id); // same row updated in place
      expect(rows[0].createdAt).toBe(first.createdAt); // createdAt never touched
      expect(rows[0].updatedAt).toBeGreaterThan(first.updatedAt);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  // [Test 3 / PRD §8.3 isolation] user-scoping via the join through jobs.
  it(
    '[machine] getBrief is null for another user, an unknown job, and a job with no brief',
    async () => {
      const { upsertBrief, getBrief } = await importQueries();
      const owner = await freshUser();
      const other = await freshUser();
      const jobId = await seedJob(owner);
      await upsertBrief(jobId, INTEL, validRehearse());

      // Another user cannot read the owner's brief even though the row exists.
      await expect(getBrief(other, jobId)).resolves.toBeNull();
      // An unknown job id.
      await expect(getBrief(owner, crypto.randomUUID())).resolves.toBeNull();
      // A real job the owner owns, but with no brief yet.
      const jobNoBrief = await seedJob(owner);
      await expect(getBrief(owner, jobNoBrief)).resolves.toBeNull();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  // [Test 4 / drift policy + PII logging] a corrupted rehearse jsonb throws loud.
  it(
    '[machine] getBrief throws when the stored rehearse jsonb violates the schema; logs paths only',
    async () => {
      const { getBrief } = await importQueries();
      const userId = await freshUser();
      const jobId = await seedJob(userId);
      // askThem of length 2 — valid JSON, invalid shape (.length(3) violated).
      const brokenRehearse = validRehearse();
      brokenRehearse.askThem = ['only', 'two'];
      await db.insert(schema.briefs).values({
        jobId,
        intel: null,
        rehearse: brokenRehearse as unknown as Rehearse,
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await expect(getBrief(userId, jobId)).rejects.toThrow(/does not match the Brief schema/);
        // The log line carries Zod PATHS only — never a question/positioning value (PII).
        expect(errorSpy).toHaveBeenCalled();
        const [, context] = errorSpy.mock.calls[0] as [string, { jobId: string; issues: string[] }];
        expect(context.jobId).toBe(jobId);
        expect(context.issues.some((p) => p.startsWith('rehearse'))).toBe(true);
        expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('sharding key');
      } finally {
        errorSpy.mockRestore();
      }
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  // [Test 5 / D5] a < 5-question brief round-trips through the RELAXED persisted schema,
  // even though it FAILS the strict FND-03 Rehearse. This is the machine proof that a
  // dropped-question Brief persists.
  it(
    '[machine] D5: upsertBrief persists a 4-question rehearse (relaxed schema) that FAILS strict FND-03 Rehearse',
    async () => {
      const { upsertBrief, getBrief } = await importQueries();
      const userId = await freshUser();
      const jobId = await seedJob(userId);

      const filtered = validRehearse();
      filtered.questions = filtered.questions.slice(0, 4); // one dropped by referential integrity

      // Documenting WHY the relaxed schema is needed: strict FND-03 rejects this value.
      expect(Rehearse.safeParse(filtered).success).toBe(false);

      // ...but the persistence round-trip accepts it (does NOT throw).
      const returned = await upsertBrief(jobId, null, filtered as unknown as Rehearse);
      expect(returned.rehearse.questions).toHaveLength(4);

      const read = await getBrief(userId, jobId);
      expect(read!.rehearse.questions).toHaveLength(4);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  // [Test 6 / acceptance item 6 at the query layer] intel null round-trip.
  it(
    '[machine] upsertBrief with intel null persists intel === null and reads it back',
    async () => {
      const { upsertBrief, getBrief } = await importQueries();
      const userId = await freshUser();
      const jobId = await seedJob(userId);

      await upsertBrief(jobId, null, validRehearse());

      const read = await getBrief(userId, jobId);
      expect(read).not.toBeNull();
      expect(read!.intel).toBeNull();
      expect(read!.rehearse.questions).toHaveLength(5);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  // [Test 7 / FND-08 build-time-safety class]
  it(
    '[machine] the module imports cleanly with DATABASE_URL unset; @/db/index rejects',
    async () => {
      vi.stubEnv('DATABASE_URL', '');
      try {
        vi.resetModules();
        vi.doUnmock('@/db/index');
        await expect(import('@/lib/db/queries/briefs')).resolves.toBeDefined();
        await expect(import('@/db/index')).rejects.toThrow(/DATABASE_URL/);
      } finally {
        vi.unstubAllEnvs();
      }
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  // ISS-29 guard — mirrors tailored-resumes.test.ts: reads the timeout Vitest actually
  // BOUND to each task in this file and fails if the raise ever stops taking effect.
  it(
    '[machine] ISS-29 guard: every test in this file got the raised PGlite timeout bound',
    ({ task }) => {
      const siblings = (task.suite?.tasks ?? []).filter((t) => t.type === 'test');
      expect(siblings.length).toBeGreaterThanOrEqual(7);
      const notRaised = siblings
        .filter((t) => t.timeout < PGLITE_TEST_TIMEOUT_MS)
        .map((t) => `${t.name} (${t.timeout}ms)`);
      expect(notRaised).toEqual([]);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});
