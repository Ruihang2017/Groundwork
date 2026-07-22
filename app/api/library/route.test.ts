import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import type { Library } from '@/lib/schemas/entities';

// LIB-02 — the machine-checkable acceptance surface for GET/POST /api/library.
//
// The route reaches `@/auth` (via requireUserId) and — LAZILY, and that laziness is
// itself load-bearing (test "build guard" below) — `@/lib/db/queries/library`.
// `@/auth` is mocked file-wide via vi.hoisted so the mock fn keeps a STABLE
// reference across each test's vi.resetModules(); the query module is either
// swapped for vi.fn()s (call-count assertions) or left real with `@/db/index`
// pointed at a PGlite instance (end-to-end assertions through real SQL). Mirrors
// app/api/parse/route.test.ts + app/api/account/delete/route.test.ts.

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock('@/auth', () => ({ auth: mockAuth }));

// ISS-29: see lib/db/queries/library.test.ts. Third argument of every it() — the
// only placement Vitest actually binds (task timeouts resolve at COLLECTION time).
const PGLITE_TEST_TIMEOUT_MS = 30_000;

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

let db: TestDb;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './db/migrations' });
}, PGLITE_TEST_TIMEOUT_MS);

afterEach(() => {
  mockAuth.mockReset();
});

function signedInAs(userId: string) {
  mockAuth.mockResolvedValue({ user: { id: userId } } as never);
}

function signedOut() {
  mockAuth.mockResolvedValue(null as never);
}

async function seedUser(userId = crypto.randomUUID()) {
  await db.insert(schema.users).values({ id: userId, email: `${userId}@example.com` });
  return userId;
}

/** Loads a fresh route with the query module swapped for spies (call-count assertions). */
async function loadRouteWithMockedQueries(
  overrides: {
    getLibrary?: ReturnType<typeof vi.fn>;
    getResume?: ReturnType<typeof vi.fn>;
    confirmLibraryImport?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const getLibrary = overrides.getLibrary ?? vi.fn(async () => null);
  const getResume = overrides.getResume ?? vi.fn(async () => null);
  const confirmLibraryImport = overrides.confirmLibraryImport ?? vi.fn(async () => {});
  vi.resetModules();
  vi.doMock('@/lib/db/queries/library', () => ({
    getLibrary,
    getResume,
    confirmLibraryImport,
  }));
  const mod = await import('@/app/api/library/route');
  return { GET: mod.GET, POST: mod.POST, getLibrary, getResume, confirmLibraryImport };
}

/** Loads a fresh route with the REAL query module running against PGlite. */
async function loadRouteWithRealQueries() {
  vi.resetModules();
  vi.doUnmock('@/lib/db/queries/library');
  vi.doMock('@/db/index', () => ({ db, dbTx: db }));
  const mod = await import('@/app/api/library/route');
  return { GET: mod.GET, POST: mod.POST };
}

function postRequest(body: unknown, contentType = 'application/json'): Request {
  return new Request('http://localhost/api/library', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// --- Fixtures ----------------------------------------------------------------
// `contact.links` supplied explicitly: it has `.default([])`, so omitting it would
// make the Zod round-trip ADD the key (plan §4 R11) and break a strict toEqual.
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
        stack: ['TypeScript'],
        summary: 'Streaming ASR + LLM orchestration with barge-in.',
        metrics: ['12k MAU'],
        tags: ['llm'],
      },
    ],
    ...overrides,
  };
}

const NUL = String.fromCharCode(0);

describe('GET /api/library', () => {
  // [R1 / PRD §8.3]
  it('[machine] returns 401 and makes ZERO query calls when unauthenticated', async () => {
    signedOut();
    const { GET, getLibrary, getResume } = await loadRouteWithMockedQueries();

    const res = await GET();

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(getLibrary).not.toHaveBeenCalled();
    expect(getResume).not.toHaveBeenCalled();
  }, PGLITE_TEST_TIMEOUT_MS);

  // [R2] "no library yet" is 200-with-nulls, NOT a 404 (ticket Deliverable 2).
  it('[machine] returns 200 { library: null, resumeMd: null } for a user with nothing', async () => {
    const userId = await seedUser();
    signedInAs(userId);
    const { GET } = await loadRouteWithRealQueries();

    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ library: null, resumeMd: null });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  }, PGLITE_TEST_TIMEOUT_MS);

  // [R3] round trip through real SQL.
  it('[machine] returns what POST persisted, with Cache-Control: no-store', async () => {
    const userId = await seedUser();
    signedInAs(userId);
    const { GET, POST } = await loadRouteWithRealQueries();
    const library = makeLibrary();
    const resumeMd = '# Ada Lovelace\n\nStreaming ASR work.';

    const postRes = await POST(postRequest({ library, resumeMd }));
    expect(postRes.status).toBe(200);

    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ library, resumeMd });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  }, PGLITE_TEST_TIMEOUT_MS);

  // [R4 / acceptance 8] cross-user isolation THROUGH the route, on both tables.
  it('[machine] never returns another user’s library or resume', async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    const userC = await seedUser(); // has nothing
    const libraryA = makeLibrary();
    const libraryB = makeLibrary({
      profile: { name: 'Grace Hopper', contact: { links: [] } },
      projects: [{ ...libraryA.projects[0], id: 'compiler', name: 'A-0 Compiler' }],
    });

    const { GET, POST } = await loadRouteWithRealQueries();

    signedInAs(userA);
    await POST(postRequest({ library: libraryA, resumeMd: '# resume A' }));
    signedInAs(userB);
    await POST(postRequest({ library: libraryB, resumeMd: '# resume B' }));

    // B's session sees only B.
    const resB = await GET();
    await expect(resB.json()).resolves.toEqual({ library: libraryB, resumeMd: '# resume B' });

    // A's session sees only A.
    signedInAs(userA);
    const resA = await GET();
    await expect(resA.json()).resolves.toEqual({ library: libraryA, resumeMd: '# resume A' });

    // A third user with no rows sees nulls, not somebody else's data.
    signedInAs(userC);
    const resC = await GET();
    await expect(resC.json()).resolves.toEqual({ library: null, resumeMd: null });
  }, PGLITE_TEST_TIMEOUT_MS);

  // 500 path: the error body carries no resume text and no internal detail.
  it('[machine] returns 500 library_read_failed when a query throws', async () => {
    signedInAs(crypto.randomUUID());
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { GET } = await loadRouteWithMockedQueries({
        getLibrary: vi.fn(async () => {
          throw new Error('Stored library row does not match the Library schema');
        }),
      });

      const res = await GET();

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: 'library_read_failed' });
    } finally {
      errorSpy.mockRestore();
    }
  }, PGLITE_TEST_TIMEOUT_MS);
});

describe('POST /api/library', () => {
  // [R6 / PRD §8.3]
  it('[machine] returns 401 and calls confirmLibraryImport ZERO times when unauthenticated', async () => {
    signedOut();
    const { POST, confirmLibraryImport } = await loadRouteWithMockedQueries();

    const res = await POST(postRequest({ library: makeLibrary(), resumeMd: '# md' }));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(confirmLibraryImport).not.toHaveBeenCalled();
  }, PGLITE_TEST_TIMEOUT_MS);

  // [R5 / acceptance 7] every rejection path is a 400 with ZERO DB calls.
  it.each([
    ['an empty object', {} as unknown],
    ['a non-string resumeMd', { library: makeLibrary(), resumeMd: 42 }],
    [
      'a non-kebab-case project id',
      {
        library: makeLibrary({
          projects: [{ ...makeLibrary().projects[0], id: 'Not_KebabCase' }],
        }),
        resumeMd: '# md',
      },
    ],
    [
      'a profile missing name',
      { library: { profile: {}, projects: [] }, resumeMd: '# md' },
    ],
    ['an over-length resumeMd', { library: makeLibrary(), resumeMd: 'x'.repeat(200_001) }],
    ['a NUL character in resumeMd', { library: makeLibrary(), resumeMd: `a${NUL}b` }],
    [
      'a NUL character nested inside library.profile.name',
      {
        library: makeLibrary({ profile: { name: `Ada${NUL}`, contact: { links: [] } } }),
        resumeMd: '# md',
      },
    ],
    ['a body that is not JSON at all', 'this is not json'],
  ])(
    '[machine] returns 400 invalid_body with ZERO DB calls for %s',
    async (_label, body) => {
      signedInAs(crypto.randomUUID());
      const { POST, confirmLibraryImport } = await loadRouteWithMockedQueries();

      const res = await POST(
        typeof body === 'string' ? postRequest(body, 'text/plain') : postRequest(body),
      );

      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string; issues: string[] };
      expect(json.error).toBe('invalid_body');
      expect(Array.isArray(json.issues)).toBe(true);
      expect(json.issues.length).toBeGreaterThan(0);
      // Every issue is a "path: message" string — never an offending VALUE.
      expect(json.issues.every((i) => typeof i === 'string')).toBe(true);
      expect(confirmLibraryImport).not.toHaveBeenCalled();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  // [R7] happy path through real SQL: both rows land with the submitted content.
  it('[machine] persists both tables and echoes { library, resumeMd }', async () => {
    const userId = await seedUser();
    signedInAs(userId);
    const { POST } = await loadRouteWithRealQueries();
    const library = makeLibrary();
    const resumeMd = '# Ada Lovelace\n\n- 12k MAU';

    const res = await POST(postRequest({ library, resumeMd }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ library, resumeMd });
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    const libRows = await db
      .select()
      .from(schema.libraries)
      .where(eq(schema.libraries.userId, userId));
    const resRows = await db
      .select()
      .from(schema.resumes)
      .where(eq(schema.resumes.userId, userId));
    expect(libRows).toHaveLength(1);
    expect(resRows).toHaveLength(1);
    expect(libRows[0].profile).toEqual(library.profile);
    expect(libRows[0].projects).toEqual(library.projects);
    expect(resRows[0].sourceMd).toBe(resumeMd);
  }, PGLITE_TEST_TIMEOUT_MS);

  // [R8 / PRD §8.3] TRUST BOUNDARY: `z.object` strips unknown keys, so a
  // client-supplied userId/id/deletedAt in the body can never reach a query.
  it('[machine] ignores a body-supplied userId/id/deletedAt and writes under the SESSION user', async () => {
    const attacker = await seedUser();
    const victim = await seedUser();
    const { GET, POST } = await loadRouteWithRealQueries();

    // Seed the victim's own rows first, through their own session.
    const victimLibrary = makeLibrary({
      profile: { name: 'Grace Hopper', contact: { links: [] } },
    });
    signedInAs(victim);
    await POST(postRequest({ library: victimLibrary, resumeMd: '# victim' }));

    // The attacker POSTs their own content while claiming to be the victim.
    signedInAs(attacker);
    const attackerLibrary = makeLibrary();
    const res = await POST(
      postRequest({
        library: attackerLibrary,
        resumeMd: '# attacker',
        userId: victim,
        id: 'forged-row-id',
        deletedAt: 1,
      }),
    );
    expect(res.status).toBe(200);
    // The echo carries only the two schema keys — the injected ones were stripped.
    await expect(res.json()).resolves.toEqual({
      library: attackerLibrary,
      resumeMd: '# attacker',
    });

    // Written under the ATTACKER...
    const attackerRows = await db
      .select()
      .from(schema.libraries)
      .where(eq(schema.libraries.userId, attacker));
    expect(attackerRows).toHaveLength(1);
    expect(attackerRows[0].profile).toEqual(attackerLibrary.profile);
    expect(attackerRows[0].id).not.toBe('forged-row-id');
    expect(attackerRows[0].deletedAt).toBeNull();

    // ...and the victim's rows are untouched.
    signedInAs(victim);
    const victimRes = await GET();
    await expect(victimRes.json()).resolves.toEqual({
      library: victimLibrary,
      resumeMd: '# victim',
    });
  }, PGLITE_TEST_TIMEOUT_MS);

  // [R10] the 500 path leaks nothing.
  it('[machine] returns 500 library_write_failed with no resume text in the body', async () => {
    signedInAs(crypto.randomUUID());
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { POST } = await loadRouteWithMockedQueries({
        confirmLibraryImport: vi.fn(async () => {
          throw new Error('insert into "resumes" ... — SECRET RESUME TEXT in params');
        }),
      });

      const res = await POST(
        postRequest({ library: makeLibrary(), resumeMd: '# SECRET RESUME TEXT' }),
      );

      expect(res.status).toBe(500);
      const raw = await res.text();
      expect(JSON.parse(raw)).toEqual({ error: 'library_write_failed' });
      expect(raw).not.toContain('SECRET RESUME TEXT');
      expect(raw).not.toContain('Ada Lovelace');
    } finally {
      errorSpy.mockRestore();
    }
  }, PGLITE_TEST_TIMEOUT_MS);
});

describe('/api/library module safety', () => {
  // [R9] BUILD GUARD. `next build`'s "Collecting page data" statically imports every
  // route module, and db/index.ts THROWS at import time without DATABASE_URL. Every
  // other test here mocks the query module (or @/db/index) and would therefore MASK
  // a static import — this one deliberately un-mocks both. FND-08 shipped exactly
  // this bug and had to bounce-fix it.
  it('[machine] the route module imports cleanly with DATABASE_URL unset', async () => {
    vi.stubEnv('DATABASE_URL', '');
    try {
      vi.resetModules();
      vi.doUnmock('@/lib/db/queries/library');
      vi.doUnmock('@/db/index');

      await expect(import('@/app/api/library/route')).resolves.toBeDefined();
      // The query module must ALSO be import-safe: LIB-03's and FIT-03's server
      // components import it directly, and page modules are collected too.
      await expect(import('@/lib/db/queries/library')).resolves.toBeDefined();

      // Sanity: the module that would have blown up really does blow up, so this
      // test cannot pass merely because DATABASE_URL happened to be set.
      await expect(import('@/db/index')).rejects.toThrow(/DATABASE_URL/);
    } finally {
      vi.unstubAllEnvs();
    }
  }, PGLITE_TEST_TIMEOUT_MS);

  // ISS-29 guard, mirroring app/api/account/delete/route.test.ts and
  // lib/db/queries/library.test.ts: reads the timeout Vitest actually BOUND and
  // fails if the raise ever stops taking effect.
  it('[machine] ISS-29 guard: every test in this file got the raised PGlite timeout bound', ({
    task,
  }) => {
    // This file has THREE top-level describes, so walk the whole file tree rather
    // than one suite's siblings (as the single-describe files do).
    type AnyTask = { type: string; name: string; timeout: number; tasks?: AnyTask[] };
    const flatten = (tasks: AnyTask[]): AnyTask[] =>
      tasks.flatMap((t) => (t.type === 'suite' ? flatten(t.tasks ?? []) : [t]));
    const allTests = flatten((task.file?.tasks ?? []) as unknown as AnyTask[]).filter(
      (t) => t.type === 'test',
    );
    expect(allTests.length).toBeGreaterThanOrEqual(15);
    const notRaised = allTests
      .filter((t) => t.timeout < PGLITE_TEST_TIMEOUT_MS)
      .map((t) => `${t.name} (${t.timeout}ms)`);
    expect(notRaised).toEqual([]);
  }, PGLITE_TEST_TIMEOUT_MS);
});
