import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import type { JdExtract } from '@/lib/schemas/pipeline';

// FIT-01 — the machine-checkable acceptance surface for GET/PATCH /api/jobs/[id].
//
// These tests run the REAL query module against PGlite (they are about routing,
// isolation and status transitions, and PGlite makes them end-to-end cheaply). The
// query module resolves `@/db/index` at call time, so `vi.doMock('@/db/index', ...)`
// + `vi.resetModules()` before a fresh dynamic import is what swaps in PGlite.
// `@/auth` is mocked file-wide via vi.hoisted so its reference survives resetModules.
//
// Next 15: a dynamic route's second handler argument is `{ params: Promise<...> }`.
// The tests pass `{ params: Promise.resolve({ id }) }` for exactly that reason.

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock('@/auth', () => ({ auth: mockAuth }));

// ISS-29: third argument of every it() — the only placement Vitest actually binds.
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
  vi.restoreAllMocks();
});

function signedInAs(userId: string) {
  mockAuth.mockResolvedValue({ user: { id: userId } } as never);
}

function signedOut() {
  mockAuth.mockResolvedValue(null as never);
}

async function loadRoute() {
  vi.resetModules();
  vi.doUnmock('@/lib/db/queries/jobs');
  vi.doMock('@/db/index', () => ({ db, dbTx: db }));
  const mod = await import('@/app/api/jobs/[id]/route');
  return { GET: mod.GET, PATCH: mod.PATCH };
}

const JD: JdExtract = {
  requirements: [{ id: 'r1', text: 'Kubernetes', weight: 3, category: 'technical' }],
  atsKeywords: ['Kubernetes'],
  subtext: [],
};

async function seedUser() {
  const userId = crypto.randomUUID();
  await db.insert(schema.users).values({ id: userId, email: `${userId}@example.com` });
  return userId;
}

async function seedJob(userId: string) {
  const [row] = await db
    .insert(schema.jobs)
    .values({
      userId,
      company: 'Acme',
      role: 'Staff SWE',
      status: 'screening',
      jdRaw: 'We are hiring.',
      jd: JD,
    })
    .returning();
  return row;
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function getRequest(id: string): Request {
  return new Request(`http://localhost/api/jobs/${id}`);
}

function patchRequest(id: string, body: unknown): Request {
  return new Request(`http://localhost/api/jobs/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function jobRow(id: string) {
  const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
  return row;
}

describe('GET /api/jobs/[id]', () => {
  it(
    '[machine] unauthenticated ⇒ 401',
    async () => {
      const { GET } = await loadRoute();
      signedOut();

      const res = await GET(getRequest('anything'), ctx('anything'));

      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' });
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] the owner gets 200 + no-store, with ledger/fit as explicit nulls',
    async () => {
      const { GET } = await loadRoute();
      const userId = await seedUser();
      const seeded = await seedJob(userId);
      signedInAs(userId);

      const res = await GET(getRequest(seeded.id), ctx(seeded.id));

      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      const job = (await res.json()) as Record<string, unknown>;
      expect(job.id).toBe(seeded.id);
      expect(job.userId).toBe(userId);
      expect(job.status).toBe('screening');
      expect(job.jd).toEqual(JD);
      // FIT-03 branches on these being present-and-null, not absent.
      expect(job).toHaveProperty('ledger', null);
      expect(job).toHaveProperty('fit', null);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  // ✅ Ticket acceptance item 5 — cross-user isolation, and 404 rather than 403.
  it(
    "[machine] another user's job ⇒ 404 not_found (NOT 403), byte-identical to an unknown id",
    async () => {
      const { GET } = await loadRoute();
      const owner = await seedUser();
      const attacker = await seedUser();
      const seeded = await seedJob(owner);
      signedInAs(attacker);

      const notYours = await GET(getRequest(seeded.id), ctx(seeded.id));
      const unknownId = crypto.randomUUID();
      const notFound = await GET(getRequest(unknownId), ctx(unknownId));

      expect(notYours.status).toBe(404);
      expect(notFound.status).toBe(404);
      // Identical bodies: a 403 (or any different body) would confirm the id exists,
      // which is itself an information leak (ticket Deliverable 2).
      expect(await notYours.text()).toBe(await notFound.text());
      expect(await (await GET(getRequest(seeded.id), ctx(seeded.id))).json()).toEqual({
        error: 'not_found',
      });
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] a drifted stored row ⇒ 500 job_read_failed (the job exists; this is not a 404)',
    async () => {
      const { GET } = await loadRoute();
      const userId = await seedUser();
      const [seeded] = await db
        .insert(schema.jobs)
        .values({
          userId,
          company: 'Acme',
          role: 'Engineer',
          status: 'screening',
          jdRaw: 'jd',
          jd: { requirements: [{ id: 'r1', weight: 9 }] } as unknown as JdExtract,
        })
        .returning();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      signedInAs(userId);

      const res = await GET(getRequest(seeded.id), ctx(seeded.id));

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: 'job_read_failed' });
      errorSpy.mockRestore();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

describe('PATCH /api/jobs/[id]', () => {
  it(
    '[machine] unauthenticated ⇒ 401 before the body is even read',
    async () => {
      const { PATCH } = await loadRoute();
      signedOut();

      const res = await PATCH(patchRequest('x', { status: 'applied' }), ctx('x'));

      expect(res.status).toBe(401);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] moves screening → applied → interviewing → closed, persisted each time',
    async () => {
      const { PATCH } = await loadRoute();
      const userId = await seedUser();
      const seeded = await seedJob(userId);
      signedInAs(userId);

      for (const status of ['applied', 'interviewing', 'closed'] as const) {
        const res = await PATCH(patchRequest(seeded.id, { status }), ctx(seeded.id));
        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        const job = (await res.json()) as { status: string };
        expect(job.status).toBe(status);
        expect((await jobRow(seeded.id)).status).toBe(status);
      }
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] screening → interviewing DIRECTLY is allowed (permissive by design — PRD names no ordering)',
    async () => {
      const { PATCH } = await loadRoute();
      const userId = await seedUser();
      const seeded = await seedJob(userId);
      signedInAs(userId);

      // Inventing a state machine here would break PRP-03's "I got an interview"
      // button for anyone who never clicked "applied" first.
      const res = await PATCH(patchRequest(seeded.id, { status: 'interviewing' }), ctx(seeded.id));

      expect(res.status).toBe(200);
      expect((await jobRow(seeded.id)).status).toBe('interviewing');
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  // ✅ Ticket acceptance item 4 — enum rejection.
  const badBodies: Array<[string, unknown]> = [
    ['a status outside the enum', { status: 'archived' }],
    ['a non-string status', { status: 123 }],
    ['a missing status', {}],
    ['a null body', null],
  ];

  for (const [name, body] of badBodies) {
    it(
      `[machine] ${name} ⇒ 400 invalid_body, and the row is untouched`,
      async () => {
        const { PATCH } = await loadRoute();
        const userId = await seedUser();
        const seeded = await seedJob(userId);
        signedInAs(userId);

        const res = await PATCH(patchRequest(seeded.id, body), ctx(seeded.id));

        expect(res.status).toBe(400);
        const json = (await res.json()) as { error: string; issues: string[] };
        expect(json.error).toBe('invalid_body');
        expect(json.issues.length).toBeGreaterThan(0);
        expect((await jobRow(seeded.id)).status).toBe('screening');
      },
      PGLITE_TEST_TIMEOUT_MS,
    );
  }

  it(
    '[machine] malformed JSON ⇒ 400, not a throw',
    async () => {
      const { PATCH } = await loadRoute();
      const userId = await seedUser();
      const seeded = await seedJob(userId);
      signedInAs(userId);

      const res = await PATCH(patchRequest(seeded.id, '{nope'), ctx(seeded.id));

      expect(res.status).toBe(400);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    "[machine] another user's job ⇒ 404 AND that row is provably unchanged (no cross-user write)",
    async () => {
      const { PATCH } = await loadRoute();
      const owner = await seedUser();
      const attacker = await seedUser();
      const seeded = await seedJob(owner);
      signedInAs(attacker);

      const res = await PATCH(patchRequest(seeded.id, { status: 'closed' }), ctx(seeded.id));

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: 'not_found' });
      const row = await jobRow(seeded.id);
      expect(row.status).toBe('screening');
      expect(row.updatedAt).toBe(seeded.updatedAt);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] an unknown id ⇒ 404 not_found',
    async () => {
      const { PATCH } = await loadRoute();
      const userId = await seedUser();
      signedInAs(userId);
      const unknownId = crypto.randomUUID();

      const res = await PATCH(patchRequest(unknownId, { status: 'applied' }), ctx(unknownId));

      expect(res.status).toBe(404);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] body extras (company/userId/jd/ledger) are STRIPPED — only status changes',
    async () => {
      const { PATCH } = await loadRoute();
      const owner = await seedUser();
      const other = await seedUser();
      const seeded = await seedJob(owner);
      signedInAs(owner);

      const res = await PATCH(
        patchRequest(seeded.id, {
          status: 'applied',
          company: 'HACKED',
          userId: other,
          jd: { requirements: [] },
          ledger: { bindings: [], gaps: [] },
        }),
        ctx(seeded.id),
      );

      expect(res.status).toBe(200);
      const row = await jobRow(seeded.id);
      expect(row.status).toBe('applied');
      expect(row.company).toBe('Acme');
      expect(row.userId).toBe(owner);
      expect(row.jd).toEqual(JD);
      expect(row.ledger).toBeNull();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] the id comes only from the PATH — a different id in the body changes nothing',
    async () => {
      const { PATCH } = await loadRoute();
      const userId = await seedUser();
      const target = await seedJob(userId);
      const bystander = await seedJob(userId);
      signedInAs(userId);

      const res = await PATCH(
        patchRequest(target.id, { status: 'closed', id: bystander.id }),
        ctx(target.id),
      );

      expect(res.status).toBe(200);
      expect((await jobRow(target.id)).status).toBe('closed');
      expect((await jobRow(bystander.id)).status).toBe('screening');
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

describe('/api/jobs/[id] module safety', () => {
  // BUILD GUARD — see app/api/jobs/route.test.ts for the full reasoning (FND-08).
  it(
    '[machine] the route module imports cleanly with DATABASE_URL unset and nothing mocked',
    async () => {
      vi.stubEnv('DATABASE_URL', '');
      try {
        vi.resetModules();
        vi.doUnmock('@/lib/db/queries/jobs');
        vi.doUnmock('@/db/index');

        await expect(import('@/app/api/jobs/[id]/route')).resolves.toBeDefined();
        await expect(import('@/db/index')).rejects.toThrow(/DATABASE_URL/);
      } finally {
        vi.unstubAllEnvs();
      }
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it('[machine] ISS-29 guard: every test in this file got the raised PGlite timeout bound', ({
    task,
  }) => {
    type AnyTask = { type: string; name: string; timeout: number; tasks?: AnyTask[] };
    const flatten = (tasks: AnyTask[]): AnyTask[] =>
      tasks.flatMap((t) => (t.type === 'suite' ? flatten(t.tasks ?? []) : [t]));
    const allTests = flatten((task.file?.tasks ?? []) as unknown as AnyTask[]).filter(
      (t) => t.type === 'test',
    );
    expect(allTests.length).toBeGreaterThanOrEqual(16);
    const notRaised = allTests
      .filter((t) => t.timeout < PGLITE_TEST_TIMEOUT_MS)
      .map((t) => t.name)
      .filter((name) => !name.includes('ISS-29 guard'));
    expect(notRaised).toEqual([]);
  });
});
