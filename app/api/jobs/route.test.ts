import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';

import * as schema from '@/db/schema';
import { loadFixtures } from '@/eval/fixtures';
import { assertQ1Schema } from '@/eval/assertions/q1';
import { JdExtract } from '@/lib/schemas/pipeline';

// FIT-01 — the machine-checkable acceptance surface for POST /api/jobs.
//
// The route reaches `@/auth` (via requireUserId) and — LAZILY, and that laziness is
// itself load-bearing (the build guard at the bottom) — `@/lib/db/queries/library`,
// `@/lib/config/quota`, `@/lib/usage/record` and `@/lib/db/queries/jobs`. `@/auth` is
// mocked file-wide via vi.hoisted so the mock keeps a STABLE reference across each
// test's vi.resetModules(); the rest are swapped per test with vi.doMock + a fresh
// dynamic import. The jobs query module is normally left REAL with `@/db/index`
// pointed at PGlite, so persistence assertions go through real SQL and the real
// migration chain (including 0003's DROP NOT NULL).
//
// NO test here makes a real Anthropic call: every one stubs globalThis.fetch. A real
// call would be non-deterministic and would cost money on every CI run. A canned
// reply proves SCHEMA-SHAPE WIRING, not model quality — a green run here must never
// be reported as "Q1 green against the real model". The compensating controls are
// `pnpm eval` and the human-run smoke recipe at the bottom of lib/read/prompt.ts.

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock('@/auth', () => ({ auth: mockAuth }));

// ISS-29: PGlite boot + the real migration chain exceeds Vitest's 5000ms default
// under full-suite load. Third argument of every it() — the only placement Vitest
// actually binds (task timeouts resolve at COLLECTION time).
const PGLITE_TEST_TIMEOUT_MS = 30_000;

const RESET_AT = 1_800_000_000_000;

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

async function seedUser(userId = crypto.randomUUID()) {
  await db.insert(schema.users).values({ id: userId, email: `${userId}@example.com` });
  return userId;
}

/** A user with a library — the state POST /api/jobs requires (PRD §5.7). */
async function seedUserWithLibrary() {
  const userId = await seedUser();
  await db.insert(schema.libraries).values({
    userId,
    profile: { name: 'Ada Lovelace', contact: { links: [] } },
    projects: [
      {
        id: 'voice-agent',
        name: 'Voice Agent',
        stage: 'shipped',
        role: 'Tech lead',
        stack: ['TypeScript'],
        summary: 'Streaming ASR + LLM orchestration.',
        metrics: [],
        tags: ['llm'],
      },
    ],
  });
  return userId;
}

async function jobRowsFor(userId: string) {
  return db.select().from(schema.jobs).where(eq(schema.jobs.userId, userId));
}

// --- Module loading -----------------------------------------------------------

type QuotaResult = { allowed: boolean; remaining: number; resetAt: number };
type BreakerResult = { tripped: boolean; spentTodayUsd: number; limitUsd: number };
type RecordedUsage = {
  userId: string;
  op: string;
  tokensIn: number;
  tokensOut: number;
  searches: number;
  durationMs: number;
};

type LoadOpts = {
  hasLibrary?: Mock<(userId: string) => Promise<boolean>>;
  quota?: Mock<(userId: string, op: string) => Promise<QuotaResult>>;
  breaker?: Mock<() => Promise<BreakerResult>>;
  recordUsage?: Mock<(event: RecordedUsage) => Promise<void>>;
  /** When supplied, `@/lib/db/queries/jobs` is mocked instead of running on PGlite. */
  createJob?: Mock<(...args: unknown[]) => Promise<unknown>>;
};

async function loadPost(opts: LoadOpts = {}) {
  const hasLibrary = opts.hasLibrary ?? vi.fn(async () => true);
  const checkAndIncrementQuota =
    opts.quota ?? vi.fn(async () => ({ allowed: true, remaining: 9, resetAt: RESET_AT }));
  const checkGlobalBreaker =
    opts.breaker ?? vi.fn(async () => ({ tripped: false, spentTodayUsd: 1, limitUsd: 50 }));
  const recordUsage = opts.recordUsage ?? vi.fn(async () => {});

  vi.resetModules();
  vi.doMock('@/lib/db/queries/library', () => ({ hasLibrary }));
  vi.doMock('@/lib/config/quota', () => ({ checkAndIncrementQuota, checkGlobalBreaker }));
  vi.doMock('@/lib/usage/record', () => ({ recordUsage }));
  if (opts.createJob) {
    vi.doMock('@/lib/db/queries/jobs', () => ({ createJob: opts.createJob }));
  } else {
    vi.doUnmock('@/lib/db/queries/jobs');
    vi.doMock('@/db/index', () => ({ db, dbTx: db }));
  }

  const mod = await import('@/app/api/jobs/route');
  return { POST: mod.POST, hasLibrary, checkAndIncrementQuota, checkGlobalBreaker, recordUsage };
}

// --- Requests and canned Anthropic replies ------------------------------------

function postRequest(body: unknown, contentType = 'application/json'): Request {
  return new Request('http://localhost/api/jobs', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function anthropicResponse(
  text: string,
  usage: { input_tokens: number; output_tokens: number } = {
    input_tokens: 1000,
    output_tokens: 500,
  },
  stopReason = 'end_turn',
): Response {
  return new Response(
    JSON.stringify({ content: [{ type: 'text', text }], usage, stop_reason: stopReason }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** Queues one Response per expected call; a call past the end fails loudly. */
function stubFetch(...responses: Response[]) {
  const queue = [...responses];
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const next = queue.shift();
    if (!next) throw new Error('unexpected extra Anthropic call');
    return next;
  });
}

function validJd(overrides: Partial<JdExtract> = {}): JdExtract {
  return {
    requirements: [
      { id: 'r1', text: 'Production Kubernetes', weight: 3, category: 'technical' },
      { id: 'r2', text: '5+ years backend', weight: 2, category: 'experience' },
    ],
    atsKeywords: ['Kubernetes', 'Go'],
    subtext: ['on-call detail suggests reactive reliability work'],
    ...overrides,
  };
}

const VALID_BODY = { jdRaw: 'We are hiring a staff engineer.', company: 'Acme', role: 'Staff SWE' };

const NUL = String.fromCharCode(0);

// --- Tests --------------------------------------------------------------------

describe('POST /api/jobs — gates before any spend', () => {
  it(
    '[machine] unauthenticated ⇒ 401, no Anthropic call, no row written',
    async () => {
      const { POST } = await loadPost();
      const fetchSpy = stubFetch();
      signedOut();

      const res = await POST(postRequest(VALID_BODY));

      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  // ✅ Ticket acceptance item 1 — PRD §5.7's gate is SERVER-side, not a UI affordance.
  it(
    '[machine] hasLibrary() === false ⇒ 403 no_library, ZERO Anthropic calls, ZERO rows',
    async () => {
      const hasLibrary = vi.fn(async () => false);
      const { POST, checkAndIncrementQuota } = await loadPost({ hasLibrary });
      const fetchSpy = stubFetch();
      const userId = await seedUser();
      signedInAs(userId);

      const res = await POST(postRequest(VALID_BODY));

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: 'no_library' });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await jobRowsFor(userId)).toHaveLength(0);
      // The gate is BEFORE quota: a user with no library never burns a fit charge.
      expect(checkAndIncrementQuota).not.toHaveBeenCalled();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] a hasLibrary() THROW (stored-library drift) ⇒ 500, never 403',
    async () => {
      // Mapping drift to 403 would tell a user who HAS a library to import another.
      const hasLibrary = vi.fn(async () => {
        throw new Error('Stored library row does not match the Library schema');
      });
      const { POST } = await loadPost({ hasLibrary: hasLibrary as never });
      const fetchSpy = stubFetch();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      signedInAs(await seedUser());

      const res = await POST(postRequest(VALID_BODY));

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: 'library_check_failed' });
      expect(fetchSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  // ✅ Ticket acceptance item 2.
  it(
    '[machine] charges the fit quota EXACTLY ONCE, with (userId, "fit"), BEFORE the Anthropic call',
    async () => {
      const { POST, checkAndIncrementQuota } = await loadPost();
      const fetchSpy = stubFetch(anthropicResponse(JSON.stringify(validJd())));
      const userId = await seedUserWithLibrary();
      signedInAs(userId);

      const res = await POST(postRequest(VALID_BODY));

      expect(res.status).toBe(201);
      expect(checkAndIncrementQuota).toHaveBeenCalledTimes(1);
      expect(checkAndIncrementQuota).toHaveBeenCalledWith(userId, 'fit');
      // Order, not just presence: a paid call must never precede the quota check.
      expect(checkAndIncrementQuota.mock.invocationCallOrder[0]).toBeLessThan(
        fetchSpy.mock.invocationCallOrder[0],
      );
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] quota exhausted ⇒ 429 { error, op:"fit", resetAt }, zero Anthropic calls',
    async () => {
      const quota = vi.fn(async () => ({ allowed: false, remaining: 0, resetAt: RESET_AT }));
      const { POST } = await loadPost({ quota });
      const fetchSpy = stubFetch();
      signedInAs(await seedUserWithLibrary());

      const res = await POST(postRequest(VALID_BODY));

      expect(res.status).toBe(429);
      await expect(res.json()).resolves.toEqual({
        error: 'quota_exceeded',
        op: 'fit',
        resetAt: RESET_AT,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] a quota-check THROW fails CLOSED ⇒ 503 quota_check_failed, zero Anthropic calls',
    async () => {
      const quota = vi.fn(async () => {
        throw new Error('counter unavailable');
      });
      const { POST } = await loadPost({ quota: quota as never });
      const fetchSpy = stubFetch();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      signedInAs(await seedUserWithLibrary());

      const res = await POST(postRequest(VALID_BODY));

      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toEqual({ error: 'quota_check_failed' });
      expect(fetchSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] breaker tripped ⇒ 503, and a breaker THROW ⇒ the SAME 503 (fail closed)',
    async () => {
      const tripped = vi.fn(async () => ({ tripped: true, spentTodayUsd: 60, limitUsd: 50 }));
      const first = await loadPost({ breaker: tripped });
      const fetchSpy = stubFetch();
      const userId = await seedUserWithLibrary();
      signedInAs(userId);

      const res = await first.POST(postRequest(VALID_BODY));
      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toEqual({ error: 'global_breaker_tripped' });
      expect(fetchSpy).not.toHaveBeenCalled();

      const throwing = vi.fn(async () => {
        throw new Error('GLOBAL_DAILY_SPEND_LIMIT_USD is not set');
      });
      const second = await loadPost({ breaker: throwing as never });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const fetchSpy2 = stubFetch();
      signedInAs(userId);

      const res2 = await second.POST(postRequest(VALID_BODY));
      // Same body deliberately: the client cannot act differently on "tripped" vs
      // "misconfigured"; the operator sees the real reason in the log.
      expect(res2.status).toBe(503);
      await expect(res2.json()).resolves.toEqual({ error: 'global_breaker_tripped' });
      expect(fetchSpy2).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

describe('POST /api/jobs — body validation', () => {
  const cases: Array<[string, unknown]> = [
    ['missing jdRaw', { company: 'Acme', role: 'SWE' }],
    ['empty jdRaw', { jdRaw: '', company: 'Acme', role: 'SWE' }],
    ['whitespace-only jdRaw', { jdRaw: '   \n\t ', company: 'Acme', role: 'SWE' }],
    ['oversize jdRaw', { jdRaw: 'x'.repeat(50_001), company: 'Acme', role: 'SWE' }],
    ['missing company', { jdRaw: 'hiring', role: 'SWE' }],
    ['blank role', { jdRaw: 'hiring', company: 'Acme', role: '  ' }],
    ['non-string jdRaw', { jdRaw: 42, company: 'Acme', role: 'SWE' }],
    ['null body', null],
  ];

  for (const [name, body] of cases) {
    it(
      `[machine] ${name} ⇒ 400 invalid_body, zero Anthropic calls, zero rows`,
      async () => {
        const { POST } = await loadPost();
        const fetchSpy = stubFetch();
        const userId = await seedUserWithLibrary();
        signedInAs(userId);

        const res = await POST(postRequest(body));

        expect(res.status).toBe(400);
        const json = (await res.json()) as { error: string; issues: string[] };
        expect(json.error).toBe('invalid_body');
        expect(Array.isArray(json.issues)).toBe(true);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(await jobRowsFor(userId)).toHaveLength(0);
      },
      PGLITE_TEST_TIMEOUT_MS,
    );
  }

  it(
    '[machine] malformed JSON ⇒ 400, not a throw',
    async () => {
      const { POST } = await loadPost();
      stubFetch();
      signedInAs(await seedUserWithLibrary());

      const res = await POST(postRequest('{not json', 'application/json'));
      expect(res.status).toBe(400);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] a NUL byte anywhere in the body ⇒ 400 (Postgres would otherwise 500)',
    async () => {
      const { POST } = await loadPost();
      const fetchSpy = stubFetch();
      const userId = await seedUserWithLibrary();
      signedInAs(userId);

      const res = await POST(
        postRequest({ jdRaw: `hiring${NUL}now`, company: 'Acme', role: 'SWE' }),
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: 'invalid_body',
        issues: ['body: contains a NUL character'],
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await jobRowsFor(userId)).toHaveLength(0);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] the error body never echoes the submitted JD text',
    async () => {
      const { POST } = await loadPost();
      stubFetch();
      signedInAs(await seedUserWithLibrary());

      const res = await POST(
        postRequest({ jdRaw: 42, company: 'CONFIDENTIAL-CO', role: 'SWE' }),
      );
      const raw = await res.text();
      expect(res.status).toBe(400);
      // Zod issue PATHS and messages only — never the offending values.
      expect(raw).toContain('jdRaw');
      expect(raw).not.toContain('CONFIDENTIAL-CO');
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

describe('POST /api/jobs — the READ call and its single repair retry', () => {
  it(
    '[machine] a malformed first reply is repaired ⇒ 201 after EXACTLY 2 Anthropic calls',
    async () => {
      const { POST } = await loadPost();
      const fetchSpy = stubFetch(
        anthropicResponse('sorry, here is the data: {broken'),
        anthropicResponse(JSON.stringify(validJd())),
      );
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const userId = await seedUserWithLibrary();
      signedInAs(userId);

      const res = await POST(postRequest(VALID_BODY));

      expect(res.status).toBe(201);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(await jobRowsFor(userId)).toHaveLength(1);
      errorSpy.mockRestore();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] two unusable replies ⇒ 422 read_failed after EXACTLY 2 calls (never a 3rd), no row',
    async () => {
      const { POST, recordUsage } = await loadPost();
      const fetchSpy = stubFetch(anthropicResponse('nope'), anthropicResponse('still nope'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const userId = await seedUserWithLibrary();
      signedInAs(userId);

      const res = await POST(postRequest(VALID_BODY));

      expect(res.status).toBe(422);
      await expect(res.json()).resolves.toEqual({ error: 'read_failed' });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(await jobRowsFor(userId)).toHaveLength(0);
      // Known, accepted gap (plan §5 Q3): a paid-but-unusable call records no usage.
      expect(recordUsage).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] a transport failure ⇒ 422 with NO repair retry (a 500/timeout is not a JSON problem)',
    async () => {
      const { POST } = await loadPost();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      signedInAs(await seedUserWithLibrary());

      const res = await POST(postRequest(VALID_BODY));

      expect(res.status).toBe(422);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      errorSpy.mockRestore();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] a Zod-invalid reply (12 requirements) takes the repair path',
    async () => {
      const twelve = {
        requirements: Array.from({ length: 12 }, (_, i) => ({
          id: `r${i + 1}`,
          text: `req ${i + 1}`,
          weight: 2,
          category: 'technical',
        })),
        atsKeywords: [],
        subtext: [],
      };
      const { POST } = await loadPost();
      const fetchSpy = stubFetch(
        anthropicResponse(JSON.stringify(twelve)),
        anthropicResponse(JSON.stringify(validJd())),
      );
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const userId = await seedUserWithLibrary();
      signedInAs(userId);

      const res = await POST(postRequest(VALID_BODY));

      expect(res.status).toBe(201);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const [row] = await jobRowsFor(userId);
      expect(row.jd.requirements).toHaveLength(2);
      errorSpy.mockRestore();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] DUPLICATE requirement ids take the repair path (this route s own check, not Zod s)',
    async () => {
      // JdExtract does NOT enforce id uniqueness, but the ids are the join key
      // FIT-02's bindings/gaps point at — a duplicate silently corrupts coverage.
      const dupes = validJd({
        requirements: [
          { id: 'r1', text: 'Kubernetes', weight: 3, category: 'technical' },
          { id: 'r1', text: 'Go', weight: 2, category: 'technical' },
        ],
      });
      const { POST } = await loadPost();
      const fetchSpy = stubFetch(
        anthropicResponse(JSON.stringify(dupes)),
        anthropicResponse(JSON.stringify(validJd())),
      );
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const userId = await seedUserWithLibrary();
      signedInAs(userId);

      const res = await POST(postRequest(VALID_BODY));

      expect(res.status).toBe(201);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      // The repair turn tells the model what was actually wrong.
      const repairBody = JSON.parse(String(fetchSpy.mock.calls[1][1]?.body)) as {
        messages: Array<{ content: Array<{ text: string }> }>;
      };
      expect(repairBody.messages[0].content[0].text).toContain('unique');
      // ...and it does NOT re-send the JD (repair is about structure; re-sending
      // would double the paid input tokens and widen the injection surface).
      expect(repairBody.messages[0].content[0].text).not.toContain(VALID_BODY.jdRaw);
      const [row] = await jobRowsFor(userId);
      expect(new Set(row.jd.requirements.map((r) => r.id)).size).toBe(
        row.jd.requirements.length,
      );
      errorSpy.mockRestore();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] an EMPTY requirement id takes the repair path',
    async () => {
      const blank = validJd({
        requirements: [{ id: '  ', text: 'Kubernetes', weight: 3, category: 'technical' }],
      });
      const { POST } = await loadPost();
      const fetchSpy = stubFetch(
        anthropicResponse(JSON.stringify(blank)),
        anthropicResponse(JSON.stringify(validJd())),
      );
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      signedInAs(await seedUserWithLibrary());

      const res = await POST(postRequest(VALID_BODY));

      expect(res.status).toBe(201);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      errorSpy.mockRestore();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] a TRUNCATED reply is never a silent success — it is repaired, then 422',
    async () => {
      // The JSON below happens to be parseable; only stop_reason marks the cut-off.
      const { POST } = await loadPost();
      const fetchSpy = stubFetch(
        anthropicResponse(JSON.stringify(validJd()), { input_tokens: 10, output_tokens: 4096 }, 'max_tokens'),
        anthropicResponse(JSON.stringify(validJd()), { input_tokens: 10, output_tokens: 4096 }, 'max_tokens'),
      );
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const userId = await seedUserWithLibrary();
      signedInAs(userId);

      const res = await POST(postRequest(VALID_BODY));

      expect(res.status).toBe(422);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(await jobRowsFor(userId)).toHaveLength(0);
      errorSpy.mockRestore();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] a fenced JSON reply is accepted without burning the repair call',
    async () => {
      const { POST } = await loadPost();
      const fetchSpy = stubFetch(
        anthropicResponse('```json\n' + JSON.stringify(validJd()) + '\n```'),
      );
      signedInAs(await seedUserWithLibrary());

      const res = await POST(postRequest(VALID_BODY));

      expect(res.status).toBe(201);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

describe('POST /api/jobs — success, persistence and the trust boundary', () => {
  it(
    '[machine] 201 + no-store + a jd-only job (status screening, ledger/fit null)',
    async () => {
      const { POST } = await loadPost();
      stubFetch(anthropicResponse(JSON.stringify(validJd())));
      const userId = await seedUserWithLibrary();
      signedInAs(userId);

      const res = await POST(postRequest(VALID_BODY));

      expect(res.status).toBe(201);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      const job = (await res.json()) as Record<string, unknown>;
      expect(job.userId).toBe(userId);
      expect(job.company).toBe('Acme');
      expect(job.role).toBe('Staff SWE');
      expect(job.jdRaw).toBe(VALID_BODY.jdRaw);
      expect(job.status).toBe('screening');
      expect(job.jd).toEqual(validJd());
      // Explicit NULLs, not omitted keys — FIT-03 branches on `job.fit === null`.
      expect(job).toHaveProperty('ledger', null);
      expect(job).toHaveProperty('fit', null);

      const [row] = await jobRowsFor(userId);
      expect(row.id).toBe(job.id);
      expect(row.ledger).toBeNull();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] records usage ONCE with op "read" (not "fit") and the repair call s tokens included',
    async () => {
      const recordUsage = vi.fn(async () => {});
      const { POST } = await loadPost({ recordUsage });
      stubFetch(
        anthropicResponse('garbage', { input_tokens: 1000, output_tokens: 20 }),
        anthropicResponse(JSON.stringify(validJd()), { input_tokens: 300, output_tokens: 400 }),
      );
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const userId = await seedUserWithLibrary();
      signedInAs(userId);

      const res = await POST(postRequest(VALID_BODY));

      expect(res.status).toBe(201);
      expect(recordUsage).toHaveBeenCalledTimes(1);
      const event = recordUsage.mock.calls[0][0] as unknown as RecordedUsage;
      // UsageOp has no 'fit' value; the quota BUCKET is 'fit', the usage OP is 'read'
      // (FND-06's QUOTA_OP_TO_USAGE_OP). Conflating them breaks quota counting.
      expect(event.op).toBe('read');
      expect(event.userId).toBe(userId);
      expect(event.tokensIn).toBe(1300);
      expect(event.tokensOut).toBe(420);
      expect(event.searches).toBe(0);
      errorSpy.mockRestore();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] client-supplied userId/id/status/ledger extras are STRIPPED, never persisted',
    async () => {
      const { POST } = await loadPost();
      stubFetch(anthropicResponse(JSON.stringify(validJd())));
      const userId = await seedUserWithLibrary();
      const otherUser = await seedUser();
      signedInAs(userId);

      const res = await POST(
        postRequest({
          ...VALID_BODY,
          userId: otherUser,
          id: 'attacker-chosen-id',
          status: 'closed',
          ledger: { bindings: [], gaps: [] },
          fit: { compositeScore: 100 },
        }),
      );

      expect(res.status).toBe(201);
      const job = (await res.json()) as Record<string, unknown>;
      expect(job.userId).toBe(userId); // session, not body
      expect(job.id).not.toBe('attacker-chosen-id'); // server-generated
      expect(job.status).toBe('screening'); // not caller-selectable
      expect(job.ledger).toBeNull();
      expect(job.fit).toBeNull();
      expect(await jobRowsFor(otherUser)).toHaveLength(0);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] a failing insert ⇒ 500 job_write_failed, and the log carries no JD text',
    async () => {
      const createJob = vi.fn(async () => {
        throw new Error('insert exploded');
      });
      const { POST } = await loadPost({ createJob: createJob as never });
      stubFetch(anthropicResponse(JSON.stringify(validJd())));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      signedInAs(await seedUserWithLibrary());

      const res = await POST(
        postRequest({ ...VALID_BODY, jdRaw: 'SECRET-JD-TEXT hiring a staff engineer' }),
      );

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: 'job_write_failed' });
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('SECRET-JD-TEXT');
      errorSpy.mockRestore();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

// ✅ Ticket acceptance item 3 ([fixture]) — PRD §10 P2 "Q1 全绿", READ half.
describe('POST /api/jobs — EVL-01 JD fixture sweep', () => {
  const { jds } = loadFixtures();

  it('[machine] the fixture corpus really is the 10 JDs EVL-01 committed', () => {
    expect(jds).toHaveLength(10);
  });

  /**
   * Derives a canned JdExtract from the fixture's OWN text, so the sweep genuinely
   * varies per fixture instead of replaying one constant: the first few non-empty,
   * non-heading, non-bullet-marker lines become requirement texts.
   *
   * A canned reply proves SCHEMA-SHAPE WIRING (route → validation → jsonb → read
   * back), NOT model quality. Real quality is `pnpm eval` plus the manual smoke
   * recipe in lib/read/prompt.ts.
   */
  function cannedJdFor(text: string): JdExtract {
    const lines = text
      .split('\n')
      .map((l) => l.replace(/^[-*\s]+/, '').trim())
      .filter((l) => l.length > 12 && !l.startsWith('#'))
      .slice(0, 11);
    return {
      requirements: lines.map((line, i) => ({
        id: `r${i + 1}`,
        text: line.slice(0, 160),
        weight: ((i % 3) + 1) as 1 | 2 | 3,
        category: (['technical', 'experience', 'domain', 'logistics'] as const)[i % 4],
      })),
      atsKeywords: lines.slice(0, 3).map((l) => l.split(' ')[0]),
      subtext: lines.slice(0, 2).map((l) => `implied by: ${l.slice(0, 40)}`),
    };
  }

  for (const fixture of jds) {
    it(
      `[fixture] ${fixture.id} ⇒ a persisted job whose jd passes assertQ1Schema (≤ 11 requirements, unique ids)`,
      async () => {
        const canned = cannedJdFor(fixture.text);
        const { POST } = await loadPost();
        stubFetch(anthropicResponse(JSON.stringify(canned)));
        const userId = await seedUserWithLibrary();
        signedInAs(userId);

        const res = await POST(
          postRequest({ jdRaw: fixture.text, company: 'Acme', role: 'Engineer' }),
        );

        expect(res.status).toBe(201);
        const job = (await res.json()) as { jd: unknown };

        // EVL-02's Q1 structural gate, run over what this route actually persisted.
        const q1 = assertQ1Schema(job.jd, JdExtract, false);
        expect(q1.detail).toBe('schema valid');
        expect(q1.pass).toBe(true);

        const jd = JdExtract.parse(job.jd);
        expect(jd.requirements.length).toBeLessThanOrEqual(11);
        expect(new Set(jd.requirements.map((r) => r.id)).size).toBe(jd.requirements.length);
        expect(jd.subtext.length).toBeLessThanOrEqual(3);

        // ...and it round-tripped through real Postgres, not just through the route.
        const [row] = await jobRowsFor(userId);
        expect(JdExtract.safeParse(row.jd).success).toBe(true);
        // `.trim()` in CreateJobBody is what normalises the fixture's trailing
        // newline — the JD is otherwise persisted verbatim.
        expect(row.jdRaw).toBe(fixture.text.trim());
      },
      PGLITE_TEST_TIMEOUT_MS,
    );
  }
});

describe('/api/jobs module safety', () => {
  // BUILD GUARD. `next build`'s "Collecting page data" statically imports every
  // route module, and db/index.ts THROWS at import time without DATABASE_URL. Every
  // other test here mocks the lazily-imported modules and would MASK a static
  // import. FND-08 shipped exactly this bug and had to bounce-fix it.
  it(
    '[machine] the route module imports cleanly with DATABASE_URL unset and nothing mocked',
    async () => {
      vi.stubEnv('DATABASE_URL', '');
      try {
        vi.resetModules();
        vi.doUnmock('@/lib/db/queries/library');
        vi.doUnmock('@/lib/db/queries/jobs');
        vi.doUnmock('@/lib/config/quota');
        vi.doUnmock('@/lib/usage/record');
        vi.doUnmock('@/db/index');

        await expect(import('@/app/api/jobs/route')).resolves.toBeDefined();
        // Sanity: the module that WOULD have blown up really does.
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
    expect(allTests.length).toBeGreaterThanOrEqual(30);
    const notRaised = allTests
      .filter((t) => t.timeout < PGLITE_TEST_TIMEOUT_MS)
      .map((t) => t.name)
      // These two make no DB call and need no raise.
      .filter((name) => !name.includes('ISS-29 guard') && !name.includes('fixture corpus'));
    expect(notRaised).toEqual([]);
  });
});
