import { PGlite } from '@electric-sql/pglite';
import { eq, getTableName } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';

// The account-delete route imports:
//   - requireUserId from @/lib/auth/session (which calls auth() from @/auth)
//   - signOut from @/auth
//   - dbTx (lazily) from @/db/index
// @/auth is mocked so no real Google/Resend/DB touch; the mock fns are created
// via vi.hoisted so they keep STABLE references across the vi.resetModules()
// each test does (otherwise the mock factory would mint fresh fns on re-import
// and our handles would go stale). @/db/index is swapped per test for a PGlite-
// backed, transaction-capable Drizzle client — the same driver-independent
// abstract `.transaction()` API neon-serverless implements in production.
const { mockAuth, mockSignOut } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockSignOut: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: mockAuth, signOut: mockSignOut }));

type TestDb = Awaited<ReturnType<typeof createTestDb>>['db'];

async function createTestDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  // Real committed migration via the same migrator production runs (see
  // db/migrate.test.ts Tier 3 / lib/config/quota.test.ts).
  await migrate(db, { migrationsFolder: './db/migrations' });
  return { client, db };
}

// Loads a FRESH copy of the route with `dbTx` mocked to the given client. Mirrors
// lib/config/quota.test.ts's resetModules + doMock + dynamic-import pattern,
// scoped to the `dbTx` export the route lazily imports.
async function loadRoutePost(dbTx: unknown) {
  vi.resetModules();
  vi.doMock('@/db/index', () => ({ dbTx }));
  const mod = await import('@/app/api/account/delete/route');
  return mod.POST;
}

// --- Fixtures (Zod-valid nested jsonb, same construction style as
// db/migrate.test.ts's Tier-3 fixtures). ---------------------------------------
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
const T = 1_700_000_000_000;

// Seeds a full cross-table row set for one user: users, libraries, resumes, jobs,
// tailored_resumes, briefs, usage_events, accounts, sessions. Returns the userId
// and the created jobId (briefs/tailored_resumes are keyed by jobId, not userId).
async function seedFullUser(db: TestDb, userId: string) {
  await db.insert(schema.users).values({ id: userId, email: `${userId}@example.com` });
  await db.insert(schema.libraries).values({
    userId,
    profile,
    projects: [project],
    createdAt: T,
    updatedAt: T,
  });
  await db.insert(schema.resumes).values({ userId, sourceMd: '# Ada', updatedAt: T });

  const jobId = crypto.randomUUID();
  await db.insert(schema.jobs).values({
    id: jobId,
    userId,
    company: 'Acme',
    role: 'Staff Engineer',
    status: 'screening',
    jdRaw: 'We are hiring...',
    jd,
    ledger,
    fit,
    createdAt: T,
    updatedAt: T,
  });
  await db.insert(schema.tailoredResumes).values({
    jobId,
    alignment,
    edits: [edit],
    fullDraftMd: '# Ada Lovelace',
    createdAt: T,
    updatedAt: T,
  });
  await db.insert(schema.briefs).values({ jobId, rehearse, createdAt: T, updatedAt: T });
  await db.insert(schema.usageEvents).values({
    userId,
    op: 'cross',
    tokensIn: 1200,
    tokensOut: 800,
    searches: 0,
    costUsd: 0.042,
    durationMs: 3100,
    createdAt: T,
  });
  await db.insert(schema.accounts).values({
    userId,
    type: 'oauth',
    provider: 'google',
    providerAccountId: `sub-${userId}`,
  });
  await db.insert(schema.sessions).values({
    sessionToken: `sess-${userId}`,
    userId,
    expires: new Date('2030-01-01T00:00:00.000Z'),
  });

  return { userId, jobId };
}

// Per-user, per-table row counts. briefs/tailored_resumes are counted by their
// jobId (they carry no userId); everything else by userId / id.
async function userRowCounts(db: TestDb, userId: string, jobId: string) {
  const n = async (rows: unknown[]) => rows.length;
  return {
    users: await n(await db.select().from(schema.users).where(eq(schema.users.id, userId))),
    libraries: await n(
      await db.select().from(schema.libraries).where(eq(schema.libraries.userId, userId)),
    ),
    resumes: await n(
      await db.select().from(schema.resumes).where(eq(schema.resumes.userId, userId)),
    ),
    jobs: await n(await db.select().from(schema.jobs).where(eq(schema.jobs.userId, userId))),
    tailoredResumes: await n(
      await db
        .select()
        .from(schema.tailoredResumes)
        .where(eq(schema.tailoredResumes.jobId, jobId)),
    ),
    briefs: await n(await db.select().from(schema.briefs).where(eq(schema.briefs.jobId, jobId))),
    usageEvents: await n(
      await db.select().from(schema.usageEvents).where(eq(schema.usageEvents.userId, userId)),
    ),
    accounts: await n(
      await db.select().from(schema.accounts).where(eq(schema.accounts.userId, userId)),
    ),
    sessions: await n(
      await db.select().from(schema.sessions).where(eq(schema.sessions.userId, userId)),
    ),
  };
}

// Wraps a Drizzle client so that, INSIDE the transaction callback, the first
// `tx.delete(<table named tableName>)` throws — simulating a mid-delete failure.
// Matching by table NAME (getTableName), not object identity: the route runs
// against its OWN freshly-imported schema table objects (post-resetModules), so
// an identity comparison against this test's schema objects would never match.
function withFailingDeleteOn(db: TestDb, tableName: string): TestDb {
  return new Proxy(db as object, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return (
          cb: (tx: Record<string, unknown>) => unknown,
          config?: unknown,
        ) =>
          (target as TestDb).transaction(async (tx) => {
            const realDelete = (tx.delete as (t: unknown) => unknown).bind(tx);
            (tx as Record<string, unknown>).delete = (t: unknown) => {
              if (getTableName(t as Parameters<typeof getTableName>[0]) === tableName) {
                throw new Error(`injected failure deleting ${tableName}`);
              }
              return realDelete(t);
            };
            return cb(tx as unknown as Record<string, unknown>);
          }, config as never);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as TestDb;
}

afterEach(() => {
  mockAuth.mockReset();
  mockSignOut.mockReset();
});

// ISS-29: every test in this file boots a fresh PGlite (Postgres-in-WASM) and runs
// the real db/migrations chain inside it(); under full-suite load (37 files fanned
// across one forked worker per core) the file's first test also pays the worker's
// one-time WASM compile and has been measured at 4676ms against Vitest's 5000ms
// default — and timed out outright in issue #29's runs. Passed as each it()'s third
// argument because that is the only placement Vitest actually binds: a task's timeout
// is resolved and closed over at COLLECTION time (`options?.timeout ??
// runner.config.testTimeout`, @vitest/runner 3.2.7), so a `vi.setConfig({ testTimeout })`
// inside beforeAll runs after the binding and is a silent no-op. Scoped to this file
// only — every other file keeps the 5000ms fail-fast ceiling. The last test in the
// describe below is a guard that proves this raise is still in force.
const PGLITE_TEST_TIMEOUT_MS = 30_000;

describe('POST /api/account/delete', () => {
  it('[machine] deletes EVERY per-user row across all tables (硬删该用户全部数据)', async () => {
    const { db } = await createTestDb();
    const { userId, jobId } = await seedFullUser(db, crypto.randomUUID());
    mockAuth.mockResolvedValue({ user: { id: userId } } as never);

    const POST = await loadRoutePost(db);
    const res = await POST();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ deleted: true });

    const counts = await userRowCounts(db, userId, jobId);
    // Every one of the nine tables returns zero rows for this user.
    expect(counts).toEqual({
      users: 0,
      libraries: 0,
      resumes: 0,
      jobs: 0,
      tailoredResumes: 0,
      briefs: 0,
      usageEvents: 0,
      accounts: 0,
      sessions: 0,
    });
  }, PGLITE_TEST_TIMEOUT_MS);

  it('[machine] leaves a SECOND user entirely untouched (no cross-user deletion)', async () => {
    const { db } = await createTestDb();
    const victim = await seedFullUser(db, crypto.randomUUID());
    const bystander = await seedFullUser(db, crypto.randomUUID());
    mockAuth.mockResolvedValue({ user: { id: victim.userId } } as never);

    const POST = await loadRoutePost(db);
    await POST();

    const victimCounts = await userRowCounts(db, victim.userId, victim.jobId);
    const bystanderCounts = await userRowCounts(db, bystander.userId, bystander.jobId);

    expect(Object.values(victimCounts).every((c) => c === 0)).toBe(true);
    // The bystander's full row set is intact — one of each.
    expect(bystanderCounts).toEqual({
      users: 1,
      libraries: 1,
      resumes: 1,
      jobs: 1,
      tailoredResumes: 1,
      briefs: 1,
      usageEvents: 1,
      accounts: 1,
      sessions: 1,
    });
  }, PGLITE_TEST_TIMEOUT_MS);

  it('[machine] leaves eval_runs UNCHANGED (deliberately out of scope — no userId column)', async () => {
    const { db } = await createTestDb();
    const { userId } = await seedFullUser(db, crypto.randomUUID());
    // eval_runs is fixture/regression data with no userId — must survive a delete.
    await db.insert(schema.evalRuns).values({
      suite: 'q1',
      op: 'read',
      passRate: 0.92,
      details: { failures: ['case-3'] },
      createdAt: T,
    });
    mockAuth.mockResolvedValue({ user: { id: userId } } as never);

    const POST = await loadRoutePost(db);
    await POST();

    const evalRows = await db.select().from(schema.evalRuns);
    expect(evalRows).toHaveLength(1);
    expect(evalRows[0].passRate).toBe(0.92);
    expect(evalRows[0].details).toEqual({ failures: ['case-3'] });
  }, PGLITE_TEST_TIMEOUT_MS);

  it('[machine] rolls back ENTIRELY when a delete fails mid-transaction (no partial delete)', async () => {
    const { db } = await createTestDb();
    const { userId, jobId } = await seedFullUser(db, crypto.randomUUID());
    const before = await userRowCounts(db, userId, jobId);
    mockAuth.mockResolvedValue({ user: { id: userId } } as never);

    // Inject a failure on the `jobs` delete — several child deletes (usage_events,
    // briefs, tailored_resumes) have already run inside the transaction by then,
    // so a real ROLLBACK is required to restore them.
    const POST = await loadRoutePost(withFailingDeleteOn(db, 'jobs'));
    const res = await POST();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'Account deletion failed' });
    // signOut must NOT run on a failed delete.
    expect(mockSignOut).not.toHaveBeenCalled();

    // Every table is exactly as it was before the call — nothing partially removed.
    const after = await userRowCounts(db, userId, jobId);
    expect(after).toEqual(before);
    expect(Object.values(after).every((c) => c === 1)).toBe(true);
  }, PGLITE_TEST_TIMEOUT_MS);

  it('[machine] returns 401 and makes NO DB calls when unauthenticated', async () => {
    const { db } = await createTestDb();
    mockAuth.mockResolvedValue(null as never); // no session → requireUserId throws
    const txSpy = vi.spyOn(db, 'transaction');

    const POST = await loadRoutePost(db);
    const res = await POST();

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(txSpy).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  }, PGLITE_TEST_TIMEOUT_MS);

  it('[machine] deletes ONLY the session user — the handler reads no userId input', async () => {
    // The handler signature is POST() — it takes no Request and cannot read a
    // body/query userId even if one were sent. This proves the trust boundary:
    // the session user is deleted regardless of any attacker-supplied id.
    const { db } = await createTestDb();
    const sessionUser = await seedFullUser(db, crypto.randomUUID());
    const otherUser = await seedFullUser(db, crypto.randomUUID());
    mockAuth.mockResolvedValue({ user: { id: sessionUser.userId } } as never);

    const POST = await loadRoutePost(db);
    await POST();

    const sessionCounts = await userRowCounts(db, sessionUser.userId, sessionUser.jobId);
    const otherCounts = await userRowCounts(db, otherUser.userId, otherUser.jobId);
    expect(Object.values(sessionCounts).every((c) => c === 0)).toBe(true);
    expect(Object.values(otherCounts).every((c) => c === 1)).toBe(true);
  }, PGLITE_TEST_TIMEOUT_MS);

  it('signs the user out after a successful delete (redirect:false)', async () => {
    const { db } = await createTestDb();
    const { userId } = await seedFullUser(db, crypto.randomUUID());
    mockAuth.mockResolvedValue({ user: { id: userId } } as never);
    mockSignOut.mockResolvedValue(undefined as never);

    const POST = await loadRoutePost(db);
    await POST();

    expect(mockSignOut).toHaveBeenCalledWith({ redirect: false });
  }, PGLITE_TEST_TIMEOUT_MS);

  it('still reports deleted:true if signOut throws after a committed delete', async () => {
    const { db } = await createTestDb();
    const { userId, jobId } = await seedFullUser(db, crypto.randomUUID());
    mockAuth.mockResolvedValue({ user: { id: userId } } as never);
    // The cookie-clearing side effect fails, but the data is already gone.
    mockSignOut.mockRejectedValue(new Error('cookie store unavailable') as never);

    const POST = await loadRoutePost(db);
    const res = await POST();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ deleted: true });
    // The deletion actually happened despite the signOut failure.
    const counts = await userRowCounts(db, userId, jobId);
    expect(Object.values(counts).every((c) => c === 0)).toBe(true);
  }, PGLITE_TEST_TIMEOUT_MS);

  // ISS-29 regression guard. The first attempt at this fix raised the timeout with
  // `vi.setConfig({ testTimeout })` inside a beforeAll — which reads correct in the
  // diff but is a functional no-op: Vitest resolves each task's timeout at collection
  // time, before any hook runs, so every test silently stayed at the 5000ms default
  // and issue #29 would have recurred on the next loaded run. This test reads the
  // timeout Vitest actually bound to each task in this file and fails if the raise
  // ever stops taking effect (a moved/removed third argument, a new PGlite-backed
  // test added without one, or a Vitest upgrade that changes the binding).
  it('[machine] ISS-29 guard: every test in this file got the raised PGlite timeout bound', ({
    task,
  }) => {
    const siblings = (task.suite?.tasks ?? []).filter((t) => t.type === 'test');
    // Sanity: we really are inspecting this file's suite, not an empty list.
    expect(siblings.length).toBeGreaterThanOrEqual(9);
    const notRaised = siblings
      .filter((t) => t.timeout < PGLITE_TEST_TIMEOUT_MS)
      .map((t) => `${t.name} (${t.timeout}ms)`);
    expect(notRaised).toEqual([]);
  }, PGLITE_TEST_TIMEOUT_MS);
});
