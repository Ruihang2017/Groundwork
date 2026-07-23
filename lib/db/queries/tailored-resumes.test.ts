import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import type { Alignment, Edit, FitReport, JdExtract, Ledger } from '@/lib/schemas/pipeline';

// TLR-01 — the machine-checkable acceptance surface for
// lib/db/queries/tailored-resumes.ts.
//
// The module under test resolves its Drizzle client with `await import('@/db/index')`
// INSIDE each function (its build-time-safety rule), and db/index.ts THROWS at import
// time without DATABASE_URL. So the real module must never load here: every access
// goes through a dynamic import() made AFTER vi.doMock('@/db/index', ...) has swapped
// in a PGlite-backed client (+ vi.resetModules() so the mock takes). Same pattern as
// lib/db/queries/library.test.ts.
//
// ONE PGlite for the whole file (beforeAll), with a FRESH crypto.randomUUID() userId
// (and a fresh job row) per test for isolation. `tailored_resumes.jobId` is an FK, so
// each test seeds a real users row and a real (fitted) jobs row first.

// ISS-29: a PGlite boot + the real migration chain exceeds Vitest's 5000ms default
// under full-suite load. Passed as each it()'s THIRD ARGUMENT — the only placement
// Vitest actually binds (a task's timeout resolves at COLLECTION time, so vi.setConfig
// in a hook is a silent no-op). The last test guards that the raise stays in force.
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
  return import('@/lib/db/queries/tailored-resumes');
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
      status: 'screening',
      jdRaw: 'We are hiring.',
      jd: JD,
      ledger: LEDGER,
      fit: FIT,
    })
    .returning();
  return row.id;
}

const ALIGNMENT: Alignment = [
  { keyword: 'Kubernetes', status: 'present', note: 'in the voice-agent project' },
  { keyword: 'Terraform', status: 'missing_in_library' },
];

const EDITS: Edit[] = [
  {
    original: 'Built a streaming gateway.',
    suggested: 'Built a streaming ASR gateway on Kubernetes, sharded by session id.',
    rationale: 'Surfaces the Kubernetes keyword the JD asks for.',
    projectId: 'voice-agent',
  },
];

async function tailoredRows(jobId: string) {
  return db.select().from(schema.tailoredResumes).where(eq(schema.tailoredResumes.jobId, jobId));
}

/** Forces a wall-clock gap: `$onUpdate` is client-side ms-resolution `Date.now()`. */
function clockGap() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

describe('lib/db/queries/tailored-resumes', () => {
  // [Test 1 / D8 insert path]
  it(
    '[machine] upsert inserts a row; getTailoredResume reads it back, round-tripping jsonb',
    async () => {
      const { upsertTailoredResume, getTailoredResume } = await importQueries();
      const userId = await freshUser();
      const jobId = await seedJob(userId);

      const returned = await upsertTailoredResume(jobId, ALIGNMENT, EDITS, '# Ada\n\nBackend engineer.');
      expect(returned.jobId).toBe(jobId);
      expect(returned.alignment).toEqual(ALIGNMENT);
      expect(returned.edits).toEqual(EDITS);
      expect(returned.fullDraftMd).toBe('# Ada\n\nBackend engineer.');
      expect(typeof returned.createdAt).toBe('number');
      expect(typeof returned.updatedAt).toBe('number');

      const read = await getTailoredResume(userId, jobId);
      expect(read).not.toBeNull();
      // jsonb does not preserve key order — compare parsed objects, never JSON strings.
      expect(read!.alignment).toEqual(ALIGNMENT);
      expect(read!.edits).toEqual(EDITS);
      expect(read!.fullDraftMd).toBe('# Ada\n\nBackend engineer.');
      // The parsed value carries no `id` column (TailoredResume has no `id` field).
      expect('id' in (read as object)).toBe(false);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  // [Test 2 / D5 overwrite] one row per jobId; a re-run replaces the prior draft.
  it(
    '[machine] a second upsert for the same jobId OVERWRITES in place (one row, updatedAt bumped, createdAt kept)',
    async () => {
      const { upsertTailoredResume, getTailoredResume } = await importQueries();
      const userId = await freshUser();
      const jobId = await seedJob(userId);

      await upsertTailoredResume(jobId, ALIGNMENT, EDITS, '# first draft');
      const [first] = await tailoredRows(jobId);

      await clockGap();
      const newAlignment: Alignment = [{ keyword: 'Rust', status: 'missing_in_resume' }];
      const newEdits: Edit[] = [
        { original: 'x', suggested: 'y', rationale: 'z', projectId: 'compiler' },
      ];
      await upsertTailoredResume(jobId, newAlignment, newEdits, '# second draft');

      const rows = await tailoredRows(jobId);
      expect(rows).toHaveLength(1); // overwrite, not append

      const read = await getTailoredResume(userId, jobId);
      expect(read!.alignment).toEqual(newAlignment);
      expect(read!.edits).toEqual(newEdits);
      expect(read!.fullDraftMd).toBe('# second draft');

      expect(rows[0].id).toBe(first.id); // same row updated in place
      expect(rows[0].createdAt).toBe(first.createdAt); // createdAt never touched
      expect(rows[0].updatedAt).toBeGreaterThan(first.updatedAt);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  // [Test 3 / PRD §8.3 isolation] user-scoping via the join through jobs.
  it(
    '[machine] getTailoredResume is null for another user, an unknown job, and a job with no draft',
    async () => {
      const { upsertTailoredResume, getTailoredResume } = await importQueries();
      const owner = await freshUser();
      const other = await freshUser();
      const jobId = await seedJob(owner);
      await upsertTailoredResume(jobId, ALIGNMENT, EDITS, '# owner draft');

      // Another user cannot read the owner's draft even though the row exists.
      await expect(getTailoredResume(other, jobId)).resolves.toBeNull();
      // An unknown job id.
      await expect(getTailoredResume(owner, crypto.randomUUID())).resolves.toBeNull();
      // A real job the owner owns, but with no tailored résumé yet.
      const jobNoDraft = await seedJob(owner);
      await expect(getTailoredResume(owner, jobNoDraft)).resolves.toBeNull();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  // [Test 4 / drift policy + PII logging] a corrupted alignment jsonb throws loud.
  it(
    '[machine] getTailoredResume throws when the stored alignment jsonb violates AlignmentEntry',
    async () => {
      const { getTailoredResume } = await importQueries();
      const userId = await freshUser();
      const jobId = await seedJob(userId);
      // A status value outside the four-value AlignmentEntry enum: valid JSON, invalid shape.
      await db.insert(schema.tailoredResumes).values({
        jobId,
        alignment: [{ keyword: 'K8s', status: 'nope' }] as unknown as Alignment,
        edits: [],
        fullDraftMd: '# broken',
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await expect(getTailoredResume(userId, jobId)).rejects.toThrow(
          /does not match the TailoredResume schema/,
        );
        // The log line carries Zod PATHS only — never an alignment/edits/draft value (PII).
        expect(errorSpy).toHaveBeenCalled();
        const [, context] = errorSpy.mock.calls[0] as [string, { jobId: string; issues: string[] }];
        expect(context.jobId).toBe(jobId);
        expect(context.issues.some((p) => p.startsWith('alignment'))).toBe(true);
        expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('# broken');
      } finally {
        errorSpy.mockRestore();
      }
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  // [Test 5 / FND-08 build-time-safety class]
  it(
    '[machine] the module imports cleanly with DATABASE_URL unset; @/db/index rejects',
    async () => {
      vi.stubEnv('DATABASE_URL', '');
      try {
        vi.resetModules();
        vi.doUnmock('@/db/index');
        await expect(import('@/lib/db/queries/tailored-resumes')).resolves.toBeDefined();
        await expect(import('@/db/index')).rejects.toThrow(/DATABASE_URL/);
      } finally {
        vi.unstubAllEnvs();
      }
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  // ISS-29 guard — mirrors library.test.ts: reads the timeout Vitest actually BOUND to
  // each task in this file and fails if the raise ever stops taking effect.
  it(
    '[machine] ISS-29 guard: every test in this file got the raised PGlite timeout bound',
    ({ task }) => {
      const siblings = (task.suite?.tasks ?? []).filter((t) => t.type === 'test');
      expect(siblings.length).toBeGreaterThanOrEqual(5);
      const notRaised = siblings
        .filter((t) => t.timeout < PGLITE_TEST_TIMEOUT_MS)
        .map((t) => `${t.name} (${t.timeout}ms)`);
      expect(notRaised).toEqual([]);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});
