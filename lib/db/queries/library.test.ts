import { PGlite } from '@electric-sql/pglite';
import { eq, getTableName } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import type { Library } from '@/lib/schemas/entities';

// LIB-02 — the machine-checkable acceptance surface for lib/db/queries/library.ts.
//
// The module under test resolves its Drizzle client with `await import('@/db/index')`
// INSIDE each function (its build-time-safety rule), and db/index.ts THROWS at
// import time without DATABASE_URL. So the real module must never load here: every
// access goes through a dynamic import() made AFTER vi.doMock('@/db/index', ...)
// has swapped in a PGlite-backed client (+ vi.resetModules() so the mock takes).
// Same pattern as lib/config/quota.test.ts and app/api/account/delete/route.test.ts.
//
// ONE PGlite for the whole file (beforeAll), with a FRESH crypto.randomUUID()
// userId per test for isolation — every query in the module under test is
// userId-scoped, so distinct users give full test-to-test isolation without a
// truncate between tests. Deliberately NOT the per-test-instance style of
// app/api/account/delete/route.test.ts: that file pays ~14s for nine tests.

// ISS-29: a PGlite boot + the real migration chain exceeds Vitest's 5000ms default
// under full-suite load. Passed as each it()'s THIRD ARGUMENT because that is the
// only placement Vitest actually binds — a task's timeout is resolved and closed
// over at COLLECTION time (@vitest/runner), so `vi.setConfig` inside a hook is a
// silent no-op. The last test in this file guards that the raise stays in force.
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

/**
 * Loads a FRESH copy of the query module with `@/db/index` swapped for `client`
 * (both exports — the module uses `db` for reads/standalone upserts and `dbTx` for
 * `confirmLibraryImport`'s transaction; PGlite implements the same abstract
 * `.transaction()` API neon-serverless does).
 */
async function importQueries(client: unknown = db) {
  vi.resetModules();
  vi.doMock('@/db/index', () => ({ db: client, dbTx: client }));
  return import('@/lib/db/queries/library');
}

async function seedUser(userId: string) {
  await db.insert(schema.users).values({ id: userId, email: `${userId}@example.com` });
  return userId;
}

async function freshUser() {
  return seedUser(crypto.randomUUID());
}

// --- Fixtures ----------------------------------------------------------------
// `contact.links` is supplied explicitly: Profile.contact.links has `.default([])`,
// so omitting it would make the Zod round-trip ADD the key and a strict toEqual
// against the seeded jsonb would be comparing against the wrong thing (plan §4 R11).
function makeLibrary(overrides: Partial<Library> = {}): Library {
  return {
    profile: {
      name: 'Ada Lovelace',
      headline: 'Realtime systems engineer',
      contact: { email: 'ada@example.com', links: ['https://example.com/ada'] },
    },
    projects: [
      {
        id: 'voice-agent',
        name: 'Voice Agent',
        stage: 'shipped',
        role: 'Tech lead',
        stack: ['TypeScript', 'Rust'],
        summary: 'Streaming ASR + LLM orchestration with barge-in.',
        metrics: ['12k MAU', 'p95 340ms'],
        tags: ['llm', 'realtime'],
      },
    ],
    ...overrides,
  };
}

async function libraryRows(userId: string) {
  return db.select().from(schema.libraries).where(eq(schema.libraries.userId, userId));
}

async function resumeRows(userId: string) {
  return db.select().from(schema.resumes).where(eq(schema.resumes.userId, userId));
}

/** Forces a wall-clock gap: `$onUpdate` is client-side `Date.now()` (ms resolution), */
/** so two writes inside the same millisecond would produce equal `updatedAt`.       */
function clockGap() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

/**
 * Wraps a Drizzle client so that, INSIDE the transaction callback, `tx.insert` and
 * `tx.update` throw for the named table. Modelled on `withFailingDeleteOn` in
 * app/api/account/delete/route.test.ts. Matching by table NAME (getTableName), not
 * object identity: the module under test runs against its OWN freshly-imported
 * schema table objects (post-resetModules), so identity comparison would never match.
 */
function withFailingWritesOn(client: TestDb, tableName: string): TestDb {
  return new Proxy(client as object, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return (cb: (tx: unknown) => unknown, config?: unknown) =>
          (target as TestDb).transaction(async (tx) => {
            const handle = tx as unknown as Record<string, unknown>;
            const realInsert = (handle.insert as (t: unknown) => unknown).bind(tx);
            const realUpdate = (handle.update as (t: unknown) => unknown).bind(tx);
            const guard =
              (real: (t: unknown) => unknown, verb: string) =>
              (t: unknown) => {
                if (getTableName(t as Parameters<typeof getTableName>[0]) === tableName) {
                  throw new Error(`injected failure on ${verb} ${tableName}`);
                }
                return real(t);
              };
            handle.insert = guard(realInsert, 'insert');
            handle.update = guard(realUpdate, 'update');
            return cb(tx);
          }, config as never);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as TestDb;
}

/** Wraps a client so every `tx.execute(...)` argument made inside `.transaction()` is recorded. */
function withRecordedExecutes(client: TestDb, sink: unknown[]): TestDb {
  return new Proxy(client as object, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return (cb: (tx: unknown) => unknown, config?: unknown) =>
          (target as TestDb).transaction(async (tx) => {
            const handle = tx as unknown as Record<string, unknown>;
            const realExecute = (handle.execute as (q: unknown) => unknown).bind(tx);
            handle.execute = (q: unknown) => {
              sink.push(q);
              return realExecute(q);
            };
            return cb(tx);
          }, config as never);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as TestDb;
}

/** Depth-capped deep string scan — Drizzle's `SQL` object nests its chunks. */
function containsString(value: unknown, needle: string, depth = 0): boolean {
  if (depth > 8) return false;
  if (typeof value === 'string') return value.includes(needle);
  if (Array.isArray(value)) return value.some((v) => containsString(v, needle, depth + 1));
  if (value && typeof value === 'object') {
    return Object.values(value).some((v) => containsString(v, needle, depth + 1));
  }
  return false;
}

describe('lib/db/queries/library', () => {
  // [Q1 / acceptance 1]
  it('[machine] hasLibrary returns false for a user with no libraries row', async () => {
    const { hasLibrary } = await importQueries();
    const userId = await freshUser();

    await expect(hasLibrary(userId)).resolves.toBe(false);
  }, PGLITE_TEST_TIMEOUT_MS);

  // [Q2 / acceptance 2] an existing-but-EMPTY library is not "has a library" (§5.7).
  it('[machine] hasLibrary returns false for a row whose projects array is empty', async () => {
    const { getLibrary, hasLibrary } = await importQueries();
    const userId = await freshUser();
    await db
      .insert(schema.libraries)
      .values({ userId, profile: { name: 'Ada Lovelace' }, projects: [] });

    await expect(hasLibrary(userId)).resolves.toBe(false);
    // ...but the row itself IS readable — false here means "empty", not "missing".
    await expect(getLibrary(userId)).resolves.toEqual({
      profile: { name: 'Ada Lovelace' },
      projects: [],
    });
  }, PGLITE_TEST_TIMEOUT_MS);

  // [Q3 / acceptance 3]
  it('[machine] hasLibrary returns true after confirmLibraryImport with non-empty projects', async () => {
    const { confirmLibraryImport, getLibrary, hasLibrary } = await importQueries();
    const userId = await freshUser();
    const library = makeLibrary();

    await confirmLibraryImport(userId, library, '# Ada Lovelace');

    await expect(hasLibrary(userId)).resolves.toBe(true);
    // jsonb does not preserve key order and drops duplicate keys — compare parsed
    // objects, never serialized JSON (plan §4 R12).
    await expect(getLibrary(userId)).resolves.toEqual(library);
  }, PGLITE_TEST_TIMEOUT_MS);

  // [Q4 / acceptance 4] TLR-01's number-integrity guardrail reads this text; any
  // truncation or mutation here is a P0 for that ticket (Feedback obligation #3).
  it('[machine] getResume returns the submitted sourceMd VERBATIM (adversarial content)', async () => {
    const { confirmLibraryImport, getResume } = await importQueries();
    const userId = await freshUser();
    const sourceMd = [
      '# 简历 — Ada Lovelace 🚀',
      '',
      'Windows line ending follows.\r\n',
      '```ts',
      "const s = 'it\\'s a $1 replacement token — literal, not a capture group';",
      '```',
      '',
      "Quotes: ' \" ` and a backslash \\ and a percent %s.",
      '',
      // ~50 KB tail, so a silent column/driver truncation cannot pass.
      'x'.repeat(50_000),
    ].join('\n');

    await confirmLibraryImport(userId, makeLibrary(), sourceMd);

    const resume = await getResume(userId);
    expect(resume).not.toBeNull();
    expect(resume!.sourceMd).toBe(sourceMd); // strict equality, not toContain
    expect(typeof resume!.updatedAt).toBe('number');
  }, PGLITE_TEST_TIMEOUT_MS);

  // [Q5 / acceptance 5] ATOMICITY.
  //
  // DEVIATION IN MECHANISM (not in intent) from the ticket's literal wording
  // ("if upsertResume is mocked to throw"): confirmLibraryImport calls upsertResume
  // as a LOCAL BINDING inside the same ESM module, so an external module-mock
  // cannot intercept it. Failing the underlying `resumes` write is the same
  // scenario and additionally proves a real Postgres ROLLBACK rather than a
  // mock-shaped one.
  it('[machine] confirmLibraryImport rolls BOTH tables back when the resumes write fails', async () => {
    const userId = await freshUser();
    const original = makeLibrary();
    {
      const { confirmLibraryImport } = await importQueries();
      await confirmLibraryImport(userId, original, '# original');
    }
    const [libBefore] = await libraryRows(userId);
    const [resumeBefore] = await resumeRows(userId);
    await clockGap();

    const { confirmLibraryImport } = await importQueries(
      withFailingWritesOn(db, 'resumes'),
    );
    const replacement = makeLibrary({
      profile: { name: 'Grace Hopper', contact: { links: [] } },
    });

    await expect(
      confirmLibraryImport(userId, replacement, '# replacement'),
    ).rejects.toThrow(/injected failure/);

    // Neither table reflects the partial write — content AND updatedAt unchanged.
    const [libAfter] = await libraryRows(userId);
    const [resumeAfter] = await resumeRows(userId);
    expect(libAfter).toEqual(libBefore);
    expect(resumeAfter).toEqual(resumeBefore);
    expect(libAfter.profile).toEqual(original.profile);
    expect(resumeAfter.sourceMd).toBe('# original');
    // And no duplicate rows were left behind by the rolled-back attempt.
    expect(await libraryRows(userId)).toHaveLength(1);
    expect(await resumeRows(userId)).toHaveLength(1);
  }, PGLITE_TEST_TIMEOUT_MS);

  // [Q6 / acceptance 6] upsert, not insert-duplicate.
  it('[machine] two confirmLibraryImport calls leave exactly one row per table, updatedAt advanced', async () => {
    const { confirmLibraryImport } = await importQueries();
    const userId = await freshUser();
    const first = makeLibrary();

    await confirmLibraryImport(userId, first, '# first');
    const [libFirst] = await libraryRows(userId);
    const [resumeFirst] = await resumeRows(userId);

    await clockGap();
    const second = makeLibrary({
      profile: { name: 'Grace Hopper', contact: { links: [] } },
      projects: [{ ...first.projects[0], id: 'compiler', name: 'A-0 Compiler' }],
    });
    await confirmLibraryImport(userId, second, '# second');

    const libsAfter = await libraryRows(userId);
    const resumesAfter = await resumeRows(userId);
    expect(libsAfter).toHaveLength(1);
    expect(resumesAfter).toHaveLength(1);

    expect(libsAfter[0].profile).toEqual(second.profile);
    expect(libsAfter[0].projects).toEqual(second.projects);
    expect(resumesAfter[0].sourceMd).toBe('# second');

    expect(libsAfter[0].updatedAt).toBeGreaterThan(libFirst.updatedAt);
    expect(resumesAfter[0].updatedAt).toBeGreaterThan(resumeFirst.updatedAt);
    // The row was UPDATED in place, not replaced: same id, createdAt untouched.
    expect(libsAfter[0].id).toBe(libFirst.id);
    expect(libsAfter[0].createdAt).toBe(libFirst.createdAt);
    expect(resumesAfter[0].id).toBe(resumeFirst.id);
  }, PGLITE_TEST_TIMEOUT_MS);

  // [Q7 / acceptance 8, query half] PRD §8.3 — no cross-user path on either table.
  it('[machine] cross-user isolation: neither table leaks between two seeded users', async () => {
    const { confirmLibraryImport, getLibrary, getResume, hasLibrary } = await importQueries();
    const userA = await freshUser();
    const userB = await freshUser();

    const libraryA = makeLibrary();
    const libraryB = makeLibrary({
      profile: { name: 'Grace Hopper', contact: { links: [] } },
      projects: [{ ...libraryA.projects[0], id: 'compiler', name: 'A-0 Compiler' }],
    });
    await confirmLibraryImport(userA, libraryA, '# resume A');
    await confirmLibraryImport(userB, libraryB, '# resume B');

    await expect(getLibrary(userA)).resolves.toEqual(libraryA);
    await expect(getLibrary(userB)).resolves.toEqual(libraryB);
    expect((await getResume(userA))!.sourceMd).toBe('# resume A');
    expect((await getResume(userB))!.sourceMd).toBe('# resume B');
    await expect(hasLibrary(userA)).resolves.toBe(true);
    await expect(hasLibrary(userB)).resolves.toBe(true);

    // A's writes never touched B's rows (and vice versa): one row each, still.
    expect(await libraryRows(userA)).toHaveLength(1);
    expect(await libraryRows(userB)).toHaveLength(1);
    expect(await resumeRows(userA)).toHaveLength(1);
    expect(await resumeRows(userB)).toHaveLength(1);
  }, PGLITE_TEST_TIMEOUT_MS);

  // [Q8] the ticket Goal's "or 404-equivalent null state".
  it('[machine] getLibrary/getResume return null and hasLibrary false for an unknown userId', async () => {
    const { getLibrary, getResume, hasLibrary } = await importQueries();
    const unknownUserId = crypto.randomUUID(); // never seeded

    await expect(getLibrary(unknownUserId)).resolves.toBeNull();
    await expect(getResume(unknownUserId)).resolves.toBeNull();
    await expect(hasLibrary(unknownUserId)).resolves.toBe(false);
  }, PGLITE_TEST_TIMEOUT_MS);

  // [Q9] soft delete is respected. Unreachable in v1 (no delete endpoint exists at
  // all) — this pins the forward-compatibility behavior so a future delete ticket
  // does not have to retrofit it.
  it('[machine] a soft-deleted library is invisible and is never resurrected or overwritten', async () => {
    const { getLibrary, hasLibrary, upsertLibrary } = await importQueries();
    const userId = await freshUser();
    const tombstoneProfile = { name: 'Tombstone' };
    await db.insert(schema.libraries).values({
      userId,
      profile: tombstoneProfile,
      projects: makeLibrary().projects,
      deletedAt: 1_700_000_000_000,
    });

    await expect(getLibrary(userId)).resolves.toBeNull();
    await expect(hasLibrary(userId)).resolves.toBe(false);

    const fresh = makeLibrary();
    await upsertLibrary(userId, fresh);

    await expect(getLibrary(userId)).resolves.toEqual(fresh);
    const rows = await libraryRows(userId);
    expect(rows).toHaveLength(2); // a NEW active row, alongside the untouched tombstone
    const tombstone = rows.find((r) => r.deletedAt !== null);
    expect(tombstone).toBeDefined();
    expect(tombstone!.deletedAt).toBe(1_700_000_000_000);
    expect(tombstone!.profile).toEqual(tombstoneProfile); // content untouched
  }, PGLITE_TEST_TIMEOUT_MS);

  // [Q10 / Deliverable 1] the standalone (no-executor) path resolves `db` itself.
  it('[machine] standalone upsertLibrary/upsertResume insert then update, bumping updatedAt only', async () => {
    const { getResume, upsertLibrary, upsertResume } = await importQueries();
    const userId = await freshUser();

    await upsertLibrary(userId, makeLibrary());
    await upsertResume(userId, '# first');
    const [libFirst] = await libraryRows(userId);
    const [resumeFirst] = await resumeRows(userId);

    await clockGap();
    const updated = makeLibrary({
      profile: { name: 'Grace Hopper', contact: { links: [] } },
    });
    await upsertLibrary(userId, updated);
    await upsertResume(userId, '# second');

    const libs = await libraryRows(userId);
    const res = await resumeRows(userId);
    expect(libs).toHaveLength(1);
    expect(res).toHaveLength(1);
    expect(libs[0].profile).toEqual(updated.profile);
    expect(libs[0].updatedAt).toBeGreaterThan(libFirst.updatedAt);
    expect(libs[0].createdAt).toBe(libFirst.createdAt); // createdAt never touched
    expect(res[0].sourceMd).toBe('# second');
    expect(res[0].updatedAt).toBeGreaterThan(resumeFirst.updatedAt);
    expect((await getResume(userId))!.sourceMd).toBe('# second');
  }, PGLITE_TEST_TIMEOUT_MS);

  // [Q11] shape drift fails LOUD rather than silently reporting "no library"
  // (see the getLibrary docblock for why throw beats null here).
  it('[machine] getLibrary throws when the stored jsonb does not match the Library schema', async () => {
    const { getLibrary, hasLibrary } = await importQueries();
    const userId = await freshUser();
    // `profile: {}` is valid JSON but invalid Profile — `name` is required.
    await db.insert(schema.libraries).values({
      userId,
      profile: {} as unknown as (typeof schema.libraries.$inferInsert)['profile'],
      projects: [],
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(getLibrary(userId)).rejects.toThrow(/does not match the Library schema/);
      // hasLibrary inherits the throw by design (it delegates to getLibrary).
      await expect(hasLibrary(userId)).rejects.toThrow(/does not match the Library schema/);

      // The log line carries Zod PATHS only — never a jsonb value (PII, plan §4 S3).
      expect(errorSpy).toHaveBeenCalled();
      const [, context] = errorSpy.mock.calls[0] as [string, { userId: string; issues: string[] }];
      expect(context.userId).toBe(userId);
      expect(context.issues).toEqual(['profile.name']);
    } finally {
      errorSpy.mockRestore();
    }
  }, PGLITE_TEST_TIMEOUT_MS);

  // [Q12] the per-user advisory lock is actually issued inside the transaction.
  //
  // This is a STRUCTURAL assertion, not a proof of mutual exclusion: PGlite is a
  // single-connection in-process Postgres, so genuine concurrency cannot be
  // exercised here. What it pins is that the lock statement is not silently
  // dropped by a future refactor — the duplicate-row race it defends against
  // (no UNIQUE constraint on libraries.userId, plan §4 R1) is otherwise invisible
  // in tests.
  it('[machine] confirmLibraryImport takes a per-user advisory lock inside the transaction', async () => {
    const executed: unknown[] = [];
    const { confirmLibraryImport } = await importQueries(withRecordedExecutes(db, executed));
    const userId = await freshUser();

    await confirmLibraryImport(userId, makeLibrary(), '# locked');

    expect(executed.length).toBeGreaterThanOrEqual(1);
    expect(executed.some((q) => containsString(q, 'pg_advisory_xact_lock'))).toBe(true);
    // ...parameterized by THIS userId, not a global lock shared by all users.
    expect(executed.some((q) => containsString(q, userId))).toBe(true);
    // And the write still landed.
    expect(await libraryRows(userId)).toHaveLength(1);
  }, PGLITE_TEST_TIMEOUT_MS);

  // [Q13] CONCURRENT reads resolve the client correctly.
  //
  // This is the regression test for `dbIndex()`'s memo. The route's GET runs
  // getLibrary and getResume through Promise.all, and LIB-03's / FIT-03's server
  // components will do the same. Without the memo, two `import('@/db/index')` calls
  // issued in the same tick RACE inside Vitest's mocker — one gets the mock, the
  // other loads the real db/index.ts and dies on its DATABASE_URL fail-fast
  // (verified against vitest 3.2.7). Pinned HERE and not only via the route,
  // because a future edit that drops the route's Promise.all would silently delete
  // the coverage while leaving the module's hazard in place.
  it('[machine] getLibrary and getResume resolve the injected client when called concurrently', async () => {
    const { confirmLibraryImport, getLibrary, getResume } = await importQueries();
    const userId = await freshUser();
    const library = makeLibrary();
    await confirmLibraryImport(userId, library, '# concurrent');

    const [lib, resume] = await Promise.all([getLibrary(userId), getResume(userId)]);

    expect(lib).toEqual(library);
    expect(resume!.sourceMd).toBe('# concurrent');
  }, PGLITE_TEST_TIMEOUT_MS);

  // ISS-29 guard, mirroring app/api/account/delete/route.test.ts: reads the timeout
  // Vitest actually BOUND to each task in this file and fails if the raise ever
  // stops taking effect (a moved/removed third argument, or a new PGlite-backed
  // test added without one).
  it('[machine] ISS-29 guard: every test in this file got the raised PGlite timeout bound', ({
    task,
  }) => {
    const siblings = (task.suite?.tasks ?? []).filter((t) => t.type === 'test');
    expect(siblings.length).toBeGreaterThanOrEqual(12);
    const notRaised = siblings
      .filter((t) => t.timeout < PGLITE_TEST_TIMEOUT_MS)
      .map((t) => `${t.name} (${t.timeout}ms)`);
    expect(notRaised).toEqual([]);
  }, PGLITE_TEST_TIMEOUT_MS);
});
