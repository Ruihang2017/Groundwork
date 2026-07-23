import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';

import * as schema from '@/db/schema';
import { assertQ1Questions } from '@/eval/assertions/q1';
import { assertQ3SpecificBatch } from '@/eval/assertions/q3';
import { loadFixtures } from '@/eval/fixtures';
import { PRIMARY_MODEL } from '@/lib/config/models';
import {
  buildRehearseRepairUserText,
  buildRehearseUserText,
  REHEARSE_MAX_TOKENS,
  REHEARSE_SYSTEM_PROMPT,
} from '@/lib/rehearse/prompt';
import type { Library, Project } from '@/lib/schemas/entities';
import type { FitReport, Intel, JdExtract, Ledger, RehearseQuestion } from '@/lib/schemas/pipeline';

// PRP-02 — the machine-checkable acceptance surface for POST /api/jobs/[id]/rehearse.
//
// The route reaches `@/auth` (via requireUserId) and — LAZILY, and that laziness is
// itself load-bearing (the build guard at the bottom) — `@/lib/db/queries/jobs`,
// `@/lib/db/queries/library`, `@/lib/config/quota`, `@/lib/db/queries/briefs` and
// `@/lib/usage/record`. `@/auth` is mocked file-wide via vi.hoisted so the mock keeps a
// STABLE reference across each test's vi.resetModules(); the rest are swapped per test with
// vi.doMock + a fresh dynamic import. The JOBS and BRIEFS query modules are normally left
// REAL with `@/db/index` pointed at PGlite, so the gates AND persistence go through real SQL
// and the real migration chain; the LIBRARY module is mocked (FIT-02's proven posture).
//
// HONESTY: NO test in this file makes a real Anthropic call OR a real judge call — every one
// stubs globalThis.fetch with a reply WE wrote and injects the Q3 judge via judgeCallImpl.
// That proves WIRING (the STRICT-422 taxonomy, the repair path, schema-shape validation,
// referential integrity, persistence, logging discipline, and that the route surfaces
// questions in a shape assertQ1/assertQ3 accept), NOT question quality. A green run here
// must NEVER be reported as "Q1 全绿 / Q3 ≥ 90% against the real model" — see the file header
// and the manual smoke recipe at the bottom of lib/rehearse/prompt.ts.

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock('@/auth', () => ({ auth: mockAuth }));

// ISS-29: PGlite boot + the real migration chain exceeds Vitest's 5000ms default under
// full-suite load. Third argument of every it() — the only placement Vitest actually binds
// (task timeouts resolve at COLLECTION time).
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

// --- Fixtures -----------------------------------------------------------------

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

function validJd(overrides: Partial<JdExtract> = {}): JdExtract {
  return {
    requirements: [
      { id: 'r1', text: 'Operate Kubernetes in production at scale', weight: 3, category: 'technical' },
    ],
    atsKeywords: ['Kubernetes'],
    subtext: [],
    ...overrides,
  };
}

const VOICE_AGENT: Project = {
  id: 'voice-agent',
  name: 'Voice Agent',
  stage: 'shipped',
  role: 'Tech lead',
  stack: ['TypeScript', 'Kubernetes'],
  summary: 'Streaming ASR plus LLM orchestration behind a websocket gateway.',
  metrics: [],
  tags: ['llm'],
};

const COMPILER: Project = {
  id: 'compiler',
  name: 'Toy Compiler',
  stage: 'shipped',
  role: 'Author',
  stack: ['Rust'],
  summary: 'A bytecode compiler with a register-allocation pass.',
  metrics: ['30% fewer spills'],
  tags: ['systems'],
};

function libraryOf(...projects: Project[]): Library {
  return {
    profile: {
      name: 'Ada Lovelace',
      headline: 'Backend engineer',
      targetRole: 'Staff engineer',
      // Present on purpose: a prompt test asserts it is NOT sent to the model (D1).
      contact: { email: 'ada@example.com', links: ['https://example.com/ada'] },
    },
    projects: projects.length > 0 ? projects : [VOICE_AGENT, COMPILER],
  };
}

const VALID_LEDGER: Ledger = {
  bindings: [],
  gaps: [
    {
      requirementId: 'r1',
      probe: 'LEDGER-PROBE-MARKER: how did you run Kubernetes in production?',
      play: 'Bridge from the voice-agent gateway.',
    },
  ],
};

const VALID_FIT: FitReport = {
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

type SeedJobOpts = {
  status?: 'screening' | 'applied' | 'interviewing' | 'closed';
  ledger?: unknown;
  fit?: unknown;
  jdRaw?: string;
  jd?: JdExtract;
};

/**
 * Seeds a PREP-READY job by default: status 'interviewing' with a populated ledger + fit,
 * so it clears the D3 funnel and the paid call is reached. Override for the gate tests.
 */
async function seedJob(userId: string, opts: SeedJobOpts = {}) {
  const [row] = await db
    .insert(schema.jobs)
    .values({
      userId,
      company: 'Acme',
      role: 'Staff SWE',
      status: opts.status ?? 'interviewing',
      jdRaw: opts.jdRaw ?? 'We are hiring a staff engineer.',
      jd: opts.jd ?? validJd(),
      ledger: (opts.ledger === undefined ? VALID_LEDGER : opts.ledger) as never,
      fit: (opts.fit === undefined ? VALID_FIT : opts.fit) as never,
    })
    .returning();
  return row;
}

const VALID_INTEL: Intel = {
  snapshot: 'INTEL-MARKER: Acme is a Series C dev-tools company.',
  recent: [{ headline: 'Raised a $90M Series C (Mar 2026)', soWhat: 'Scaling fast.' }],
  engineeringSignals: ['Moving from a Rails monolith to Go (2025).'],
  talkingPoints: ['How has CI cold-start held up as you grew?'],
};

async function briefRows(jobId: string) {
  return db.select().from(schema.briefs).where(eq(schema.briefs.jobId, jobId));
}

// --- Module loading -----------------------------------------------------------

type BreakerResult = { tripped: boolean; spentTodayUsd: number; limitUsd: number };
type RecordedUsage = {
  userId: string;
  op: string;
  tokensIn: number;
  tokensOut: number;
  searches: number;
  durationMs: number;
  droppedCount?: number;
};

type LoadOpts = {
  getLibrary?: Mock<(userId: string) => Promise<Library | null>>;
  breaker?: Mock<() => Promise<BreakerResult>>;
  quota?: Mock<(userId: string, op: string) => Promise<unknown>>;
  recordUsage?: Mock<(event: RecordedUsage) => Promise<void>>;
  /** When supplied, `@/lib/db/queries/jobs` is mocked instead of running on PGlite. */
  jobs?: Record<string, unknown>;
  /** When supplied, `@/lib/db/queries/briefs` is mocked instead of running on PGlite. */
  briefs?: Record<string, unknown>;
};

async function loadPost(opts: LoadOpts = {}) {
  const getLibrary = opts.getLibrary ?? vi.fn(async () => libraryOf());
  const checkGlobalBreaker =
    opts.breaker ?? vi.fn(async () => ({ tripped: false, spentTodayUsd: 1, limitUsd: 50 }));
  // Provided so a test can assert the route NEVER calls it (D3/D11 — the `prep` unit was
  // charged upstream at PRP-01). The route imports only checkGlobalBreaker from this module.
  const checkAndIncrementQuota =
    opts.quota ?? vi.fn(async () => ({ allowed: true, remaining: 9, resetAt: 0 }));
  const recordUsage = opts.recordUsage ?? vi.fn(async () => {});

  vi.resetModules();
  vi.doMock('@/lib/db/queries/library', () => ({ getLibrary }));
  vi.doMock('@/lib/config/quota', () => ({ checkGlobalBreaker, checkAndIncrementQuota }));
  vi.doMock('@/lib/usage/record', () => ({ recordUsage }));
  if (opts.jobs) {
    vi.doMock('@/lib/db/queries/jobs', () => opts.jobs);
  } else {
    vi.doUnmock('@/lib/db/queries/jobs');
    vi.doMock('@/db/index', () => ({ db, dbTx: db }));
  }
  if (opts.briefs) {
    vi.doMock('@/lib/db/queries/briefs', () => opts.briefs);
  } else {
    vi.doUnmock('@/lib/db/queries/briefs');
  }

  const mod = await import('@/app/api/jobs/[id]/rehearse/route');
  return { POST: mod.POST, getLibrary, checkGlobalBreaker, checkAndIncrementQuota, recordUsage };
}

// --- Requests and canned Anthropic replies ------------------------------------

type PostFn = Awaited<ReturnType<typeof loadPost>>['POST'];

function callRehearse(POST: PostFn, id: string, body?: unknown) {
  const req = new Request(`http://localhost/api/jobs/${id}/rehearse`, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return POST(req, { params: Promise.resolve({ id }) });
}

/** A POST whose raw body is arbitrary bytes (for the non-JSON invalid_body case). */
function callRehearseRaw(POST: PostFn, id: string, rawBody: string) {
  const req = new Request(`http://localhost/api/jobs/${id}/rehearse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: rawBody,
  });
  return POST(req, { params: Promise.resolve({ id }) });
}

function rehearseQuestion(overrides: Partial<RehearseQuestion> = {}): RehearseQuestion {
  return {
    projectId: 'voice-agent',
    question: 'How did you shard the ASR pipeline by session id to hold the 300ms p99?',
    trap: 'What did autoscaling NOT fix, and what did you change in the sharding key instead?',
    ...overrides,
  };
}

/** `count` valid questions, cycling through the library's real project ids. */
function qs(count: number, projectIds: string[] = ['voice-agent', 'compiler']): RehearseQuestion[] {
  return Array.from({ length: count }, (_, i) =>
    rehearseQuestion({ projectId: projectIds[i % projectIds.length] }),
  );
}

/** A schema-valid Rehearse JSON string whose projectIds are in the seeded library. */
function rehearseJson(overrides: Record<string, unknown> = {}): string {
  const base = {
    questions: qs(5),
    askThem: [
      'How far through the Rails-to-Go migration is the team the candidate would join?',
      'What is still on the monolith today?',
      'Which service owns the p99 budget the JD mentions?',
    ],
    positioning: 'Lead with the latency work; bridge the on-call gap via the incident review.',
  };
  return JSON.stringify({ ...base, ...overrides });
}

/** A no-tools Anthropic Messages reply (REHEARSE never searches). */
function anthropicResponse(
  opts: {
    text: string;
    stopReason?: string;
    tokens?: { input_tokens: number; output_tokens: number };
  },
): Response {
  const { text, stopReason = 'end_turn', tokens = { input_tokens: 800, output_tokens: 400 } } = opts;
  return new Response(
    JSON.stringify({ content: [{ type: 'text', text }], usage: tokens, stop_reason: stopReason }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** A non-2xx upstream reply. */
function anthropicError(status: number): Response {
  return new Response(
    JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'upstream boom' },
    }),
    { status, headers: { 'content-type': 'application/json' } },
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

function silenceErrors() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

function requestBodyOf(fetchSpy: Mock, callIndex: number): Record<string, unknown> {
  return JSON.parse(String(fetchSpy.mock.calls[callIndex][1]?.body));
}

function userTextOf(body: Record<string, unknown>): string {
  return (body.messages as Array<{ content: Array<{ text: string }> }>)[0].content[0].text;
}

const NUL = String.fromCharCode(0);

// --- Gates before any spend ---------------------------------------------------

describe('POST /api/jobs/[id]/rehearse — gates before any spend', () => {
  it(
    '[machine] unauthenticated ⇒ 401, no Anthropic call',
    async () => {
      const { POST, checkAndIncrementQuota } = await loadPost();
      const fetchSpy = stubFetch();
      const userId = await seedUser();
      const job = await seedJob(userId);
      signedOut();

      const res = await callRehearse(POST, job.id, { intel: null });

      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(checkAndIncrementQuota).not.toHaveBeenCalled();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] an unknown id and ANOTHER USER s job produce byte-identical 404s, no fetch',
    async () => {
      const { POST } = await loadPost();
      const fetchSpy = stubFetch();
      const owner = await seedUser();
      const attacker = await seedUser();
      const job = await seedJob(owner);
      signedInAs(attacker);

      const unknown = await callRehearse(POST, 'no-such-job', { intel: null });
      const foreign = await callRehearse(POST, job.id, { intel: null });

      expect(unknown.status).toBe(404);
      expect(foreign.status).toBe(404);
      expect(await foreign.text()).toBe(await unknown.text());
      expect(fetchSpy).not.toHaveBeenCalled();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] a job read THROW (row drift) ⇒ 500 job_read_failed, never a 404, no field values logged',
    async () => {
      const getJob = vi.fn(async () => {
        throw new Error('Stored job row does not match the PersistedJob schema');
      });
      const { POST, checkAndIncrementQuota } = await loadPost({ jobs: { getJob } });
      const fetchSpy = stubFetch();
      const errorSpy = silenceErrors();
      signedInAs(await seedUser());

      const res = await callRehearse(POST, 'any-id', { intel: null });

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: 'job_read_failed' });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(checkAndIncrementQuota).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  // ✅ acceptance 1 — the §5.4 unlock gate, enforced server-side, before any spend.
  it(
    '[machine] D3: a non-interviewing job ⇒ 403 not_interviewing, quota NOT called, no fetch',
    async () => {
      for (const status of ['screening', 'applied', 'closed'] as const) {
        const { POST, checkAndIncrementQuota } = await loadPost();
        const fetchSpy = stubFetch();
        const userId = await seedUser();
        const job = await seedJob(userId, { status });
        signedInAs(userId);

        const res = await callRehearse(POST, job.id, { intel: null });

        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toEqual({ error: 'not_interviewing' });
        expect(checkAndIncrementQuota).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
      }
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] D3: interviewing but ledger/fit null ⇒ 409 fit_not_ready, no fetch',
    async () => {
      const { POST } = await loadPost();
      const fetchSpy = stubFetch();
      const userId = await seedUser();
      const job = await seedJob(userId, { status: 'interviewing', ledger: null, fit: null });
      signedInAs(userId);

      const res = await callRehearse(POST, job.id, { intel: null });

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({ error: 'fit_not_ready' });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] D8: a body missing the intel key, and a non-JSON body, ⇒ 400 invalid_body, no fetch',
    async () => {
      // Missing intel key.
      {
        const { POST } = await loadPost();
        const fetchSpy = stubFetch();
        const errorSpy = silenceErrors();
        const userId = await seedUser();
        const job = await seedJob(userId);
        signedInAs(userId);

        const res = await callRehearse(POST, job.id, {});
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: 'invalid_body' });
        expect(fetchSpy).not.toHaveBeenCalled();
        errorSpy.mockRestore();
      }
      // Non-JSON body.
      {
        const { POST } = await loadPost();
        const fetchSpy = stubFetch();
        const userId = await seedUser();
        const job = await seedJob(userId);
        signedInAs(userId);

        const res = await callRehearseRaw(POST, job.id, 'not json at all {');
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: 'invalid_body' });
        expect(fetchSpy).not.toHaveBeenCalled();
      }
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] D8: a NUL byte inside body.intel ⇒ 400 invalid_body, no fetch (protects the jsonb write)',
    async () => {
      const { POST } = await loadPost();
      const fetchSpy = stubFetch();
      const userId = await seedUser();
      const job = await seedJob(userId);
      signedInAs(userId);

      const res = await callRehearse(POST, job.id, {
        intel: { snapshot: `Acme${NUL}Corp`, recent: [], engineeringSignals: [], talkingPoints: [] },
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: 'invalid_body' });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] D3: an empty library ⇒ 409 no_library; a getLibrary THROW ⇒ 500 library_read_failed; no fetch',
    async () => {
      // Empty library.
      {
        const emptyLibrary = { ...libraryOf(), projects: [] };
        const { POST } = await loadPost({ getLibrary: vi.fn(async () => emptyLibrary) });
        const fetchSpy = stubFetch();
        const userId = await seedUser();
        const job = await seedJob(userId);
        signedInAs(userId);

        const res = await callRehearse(POST, job.id, { intel: null });
        expect(res.status).toBe(409);
        await expect(res.json()).resolves.toEqual({ error: 'no_library' });
        expect(fetchSpy).not.toHaveBeenCalled();
      }
      // getLibrary throws.
      {
        const { POST } = await loadPost({
          getLibrary: vi.fn(async () => {
            throw new Error('Stored library row does not match the Library schema');
          }) as never,
        });
        const fetchSpy = stubFetch();
        const errorSpy = silenceErrors();
        const userId = await seedUser();
        const job = await seedJob(userId);
        signedInAs(userId);

        const res = await callRehearse(POST, job.id, { intel: null });
        expect(res.status).toBe(500);
        await expect(res.json()).resolves.toEqual({ error: 'library_read_failed' });
        expect(fetchSpy).not.toHaveBeenCalled();
        errorSpy.mockRestore();
      }
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] breaker tripped ⇒ 503; a breaker THROW ⇒ the SAME 503 (fail closed); no fetch either way',
    async () => {
      const userId = await seedUser();

      const tripped = await loadPost({
        breaker: vi.fn(async () => ({ tripped: true, spentTodayUsd: 60, limitUsd: 50 })),
      });
      const job1 = await seedJob(userId);
      const fetchSpy = stubFetch();
      signedInAs(userId);
      const res = await callRehearse(tripped.POST, job1.id, { intel: null });
      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toEqual({ error: 'global_breaker_tripped' });
      expect(fetchSpy).not.toHaveBeenCalled();

      const throwing = await loadPost({
        breaker: vi.fn(async () => {
          throw new Error('GLOBAL_DAILY_SPEND_LIMIT_USD is not set');
        }) as never,
      });
      const job2 = await seedJob(userId);
      const errorSpy = silenceErrors();
      const fetchSpy2 = stubFetch();
      signedInAs(userId);
      const res2 = await callRehearse(throwing.POST, job2.id, { intel: null });
      expect(res2.status).toBe(503);
      await expect(res2.json()).resolves.toEqual({ error: 'global_breaker_tripped' });
      expect(fetchSpy2).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  // D3/D11 — the analogue of FIT-02's "pins its absence": REHEARSE charges no `prep`.
  it(
    '[machine] happy path NEVER calls checkAndIncrementQuota (the prep unit was charged at PRP-01)',
    async () => {
      const { POST, checkAndIncrementQuota } = await loadPost();
      stubFetch(anthropicResponse({ text: rehearseJson() }));
      const userId = await seedUser();
      const job = await seedJob(userId);
      signedInAs(userId);

      const res = await callRehearse(POST, job.id, { intel: VALID_INTEL });

      expect(res.status).toBe(200);
      expect(checkAndIncrementQuota).not.toHaveBeenCalled();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

// --- The paid call's shape ----------------------------------------------------

describe('POST /api/jobs/[id]/rehearse — the paid call shape', () => {
  it(
    '[machine] the request carries PRIMARY_MODEL, REHEARSE_MAX_TOKENS, NO tools, and jd+ledger+projectIds+intel',
    async () => {
      const { POST } = await loadPost();
      const fetchSpy = stubFetch(anthropicResponse({ text: rehearseJson() }));
      const userId = await seedUser();
      const job = await seedJob(userId, {
        jd: validJd({
          requirements: [
            { id: 'r1', text: 'JD-REQ-MARKER Kubernetes at scale', weight: 3, category: 'technical' },
          ],
        }),
      });
      signedInAs(userId);

      await callRehearse(POST, job.id, { intel: VALID_INTEL });

      const body = requestBodyOf(fetchSpy as unknown as Mock, 0);
      expect(body.model).toBe(PRIMARY_MODEL);
      expect(body.max_tokens).toBe(REHEARSE_MAX_TOKENS);
      expect(body.tools).toBeUndefined();
      const userText = userTextOf(body);
      expect(userText).toContain('JD-REQ-MARKER'); // the jd extract
      expect(userText).toContain('LEDGER-PROBE-MARKER'); // the ledger
      expect(userText).toContain('voice-agent'); // a library project id
      expect(userText).toContain('INTEL-MARKER'); // the body's intel
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] D1 privacy: the request contains the JdExtract but NOT jdRaw and NOT profile.contact',
    async () => {
      const { POST } = await loadPost({
        getLibrary: vi.fn(async () => libraryOf()), // libraryOf() carries a contact email
      });
      const fetchSpy = stubFetch(anthropicResponse({ text: rehearseJson() }));
      const userId = await seedUser();
      const job = await seedJob(userId, {
        jdRaw: 'SECRET-JD-RAW confidential posting body',
        jd: validJd({
          requirements: [
            { id: 'r1', text: 'SECRET-JD-EXTRACT requirement', weight: 3, category: 'technical' },
          ],
        }),
      });
      signedInAs(userId);

      await callRehearse(POST, job.id, { intel: VALID_INTEL });

      const raw = String((fetchSpy as unknown as Mock).mock.calls[0][1]?.body);
      expect(raw).toContain('SECRET-JD-EXTRACT'); // the extract IS sent
      expect(raw).not.toContain('SECRET-JD-RAW'); // the raw posting is NOT
      expect(raw).not.toContain('ada@example.com'); // profile.contact is stripped
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  // ✅ D8 intel:null pass-through into the prompt — the degrade-carried-through case.
  it(
    '[machine] D8: body { intel: null } ⇒ the user text carries the "no company research" sentinel, call proceeds',
    async () => {
      const { POST } = await loadPost();
      const fetchSpy = stubFetch(anthropicResponse({ text: rehearseJson() }));
      const userId = await seedUser();
      const job = await seedJob(userId);
      signedInAs(userId);

      const res = await callRehearse(POST, job.id, { intel: null });

      expect(res.status).toBe(200);
      const userText = userTextOf(requestBodyOf(fetchSpy as unknown as Mock, 0));
      expect(userText).toContain('No company research is available');
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

// --- The STRICT failure contract (D4) — the deliberate contrast with PRP-01 ----

describe('POST /api/jobs/[id]/rehearse — the STRICT failure contract', () => {
  // ✅ acceptance 2 — NOT a degraded 200. The sharp contrast with PRP-01/RESEARCH.
  it(
    '[machine] both replies unusable ⇒ 422 rehearse_failed after EXACTLY 2 fetch, recordUsage NOT called, NO row written',
    async () => {
      const { POST, recordUsage } = await loadPost();
      const fetchSpy = stubFetch(
        anthropicResponse({ text: 'not json at all' }),
        anthropicResponse({ text: 'still not json' }),
      );
      const errorSpy = silenceErrors();
      const userId = await seedUser();
      const job = await seedJob(userId);
      signedInAs(userId);

      const res = await callRehearse(POST, job.id, { intel: null });

      expect(res.status).toBe(422);
      await expect(res.json()).resolves.toEqual({ error: 'rehearse_failed' });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(recordUsage).not.toHaveBeenCalled();
      // STRICT: nothing persisted (contrast: RESEARCH degrades to 200/null).
      expect(await briefRows(job.id)).toHaveLength(0);
      errorSpy.mockRestore();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] the first fetch rejects (timeout) ⇒ 422 after EXACTLY 1 fetch (no repair on a transport failure)',
    async () => {
      const { POST } = await loadPost();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
      const errorSpy = silenceErrors();
      const userId = await seedUser();
      const job = await seedJob(userId);
      signedInAs(userId);

      const res = await callRehearse(POST, job.id, { intel: null });

      expect(res.status).toBe(422);
      await expect(res.json()).resolves.toEqual({ error: 'rehearse_failed' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      errorSpy.mockRestore();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] an Anthropic HTTP 500 (and 400) on the first call ⇒ 422; the log carries the upstream status',
    async () => {
      for (const status of [500, 400]) {
        const { POST } = await loadPost();
        stubFetch(anthropicError(status));
        const errorSpy = silenceErrors();
        const userId = await seedUser();
        const job = await seedJob(userId);
        signedInAs(userId);

        const res = await callRehearse(POST, job.id, { intel: null });

        expect(res.status).toBe(422);
        await expect(res.json()).resolves.toEqual({ error: 'rehearse_failed' });
        expect(JSON.stringify(errorSpy.mock.calls)).toContain(String(status));
        errorSpy.mockRestore();
      }
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  // Each hard case: the FIRST reply carries the flaw, the repair returns a valid Rehearse.
  const repairCases: Array<[string, string, string?]> = [
    ['truncated (stop_reason max_tokens)', rehearseJson(), 'max_tokens'],
    ['questions.length === 4 (proves .length(5) is enforced)', rehearseJson({ questions: qs(4) })],
    ['questions.length === 6', rehearseJson({ questions: qs(6) })],
    ['askThem.length === 2', rehearseJson({ askThem: ['a', 'b'] })],
    ['an empty trap', rehearseJson({ questions: [...qs(4), rehearseQuestion({ trap: '' })] })],
    ['a blank question', rehearseJson({ questions: [...qs(4), rehearseQuestion({ question: '   ' })] })],
    ['a blank positioning', rehearseJson({ positioning: '   ' })],
    [
      'a blank askThem[0]',
      rehearseJson({ askThem: ['   ', 'a real one', 'another real one'] }),
    ],
    ['a NUL byte in positioning', rehearseJson({ positioning: `Acme${NUL}Corp` })],
  ];

  for (const [name, badReply, stopReason] of repairCases) {
    it(
      `[machine] HARD failure — ${name} — takes the repair path and then succeeds (2 fetch calls, tokens summed)`,
      async () => {
        const recordUsage = vi.fn(async () => {});
        const { POST } = await loadPost({ recordUsage });
        const fetchSpy = stubFetch(
          anthropicResponse({ text: badReply, stopReason, tokens: { input_tokens: 900, output_tokens: 100 } }),
          anthropicResponse({ text: rehearseJson(), tokens: { input_tokens: 200, output_tokens: 80 } }),
        );
        const errorSpy = silenceErrors();
        const userId = await seedUser();
        const job = await seedJob(userId);
        signedInAs(userId);

        const res = await callRehearse(POST, job.id, { intel: null });

        expect(res.status).toBe(200);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        const event = recordUsage.mock.calls[0][0] as unknown as RecordedUsage;
        expect(event.tokensIn).toBe(1100);
        expect(event.tokensOut).toBe(180);
        errorSpy.mockRestore();
      },
      PGLITE_TEST_TIMEOUT_MS,
    );
  }

  it(
    '[machine] D7: the repair request re-sends NO jd/ledger/library/intel payload and has no tools',
    async () => {
      const { POST } = await loadPost();
      const fetchSpy = stubFetch(
        anthropicResponse({ text: 'not json' }),
        anthropicResponse({ text: rehearseJson() }),
      );
      const errorSpy = silenceErrors();
      const userId = await seedUser();
      const job = await seedJob(userId);
      signedInAs(userId);

      await callRehearse(POST, job.id, { intel: VALID_INTEL });

      const repairBody = requestBodyOf(fetchSpy as unknown as Mock, 1);
      expect(repairBody.tools).toBeUndefined();
      const repairText = userTextOf(repairBody);
      expect(repairText).not.toContain('<jd_extract>');
      expect(repairText).not.toContain('<library>');
      expect(repairText).not.toContain('<intel>');
      expect(repairText).not.toContain('INTEL-MARKER');
      // But it DOES repeat the structure rules (D7).
      expect(repairText).toContain('EXACTLY 5 questions');
      errorSpy.mockRestore();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

// --- Success + persistence + referential integrity ----------------------------

describe('POST /api/jobs/[id]/rehearse — success, persistence, referential integrity', () => {
  // ✅ acceptance 5 — a question citing a projectId not in the library is dropped + counted.
  it(
    '[machine] a projectId not in the library ⇒ 200, persisted rehearse has 4 questions, dropped.count 1, no-store',
    async () => {
      const recordUsage = vi.fn(async () => {});
      const { POST } = await loadPost({ recordUsage });
      const badQuestions = [...qs(4), rehearseQuestion({ projectId: 'ghost-project' })];
      stubFetch(anthropicResponse({ text: rehearseJson({ questions: badQuestions }) }));
      const userId = await seedUser();
      const job = await seedJob(userId);
      signedInAs(userId);

      const res = await callRehearse(POST, job.id, { intel: null });
      const body = (await res.json()) as {
        rehearse: { questions: unknown[] };
        dropped: { count: number; questions: Array<{ item: RehearseQuestion; reason: string }> };
      };

      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(body.rehearse.questions).toHaveLength(4);
      expect(body.dropped.count).toBe(1);
      expect(body.dropped.questions[0].item.projectId).toBe('ghost-project');
      expect(body.dropped.questions[0].reason).toBe('projectId not in library');

      // Persisted state agrees: the dropped question is gone from the stored rehearse.
      const [row] = await briefRows(job.id);
      expect((row.rehearse as { questions: unknown[] }).questions).toHaveLength(4);

      const event = recordUsage.mock.calls[0][0] as unknown as RecordedUsage;
      expect(event.droppedCount).toBe(1);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  // ✅ acceptance 6 — intel:null persists successfully; nothing dropped on good output.
  it(
    '[machine] happy path with body { intel: null } ⇒ 200, persisted Brief.intel null, 5 questions, dropped.count 0',
    async () => {
      const { POST } = await loadPost();
      stubFetch(anthropicResponse({ text: rehearseJson() }));
      const userId = await seedUser();
      const job = await seedJob(userId);
      signedInAs(userId);

      const res = await callRehearse(POST, job.id, { intel: null });
      const body = (await res.json()) as {
        jobId: string;
        intel: unknown;
        rehearse: { questions: unknown[] };
        dropped: { count: number };
      };

      expect(res.status).toBe(200);
      expect(body.jobId).toBe(job.id);
      expect(body.intel).toBeNull();
      expect(body.rehearse.questions).toHaveLength(5);
      expect(body.dropped.count).toBe(0);

      const [row] = await briefRows(job.id);
      expect(row.intel).toBeNull();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] D11: happy path records usage ONCE with op rehearse, searches 0, droppedCount 0, tokens from the reply',
    async () => {
      const recordUsage = vi.fn(async () => {});
      const { POST } = await loadPost({ recordUsage });
      stubFetch(anthropicResponse({ text: rehearseJson(), tokens: { input_tokens: 1234, output_tokens: 567 } }));
      const userId = await seedUser();
      const job = await seedJob(userId);
      signedInAs(userId);

      const res = await callRehearse(POST, job.id, { intel: VALID_INTEL });

      expect(res.status).toBe(200);
      expect(recordUsage).toHaveBeenCalledTimes(1);
      const event = recordUsage.mock.calls[0][0] as unknown as RecordedUsage;
      expect(event.op).toBe('rehearse');
      expect(event.userId).toBe(userId);
      expect(event.searches).toBe(0);
      expect(event.droppedCount).toBe(0);
      expect(event.tokensIn).toBe(1234);
      expect(event.tokensOut).toBe(567);
      expect(typeof event.durationMs).toBe('number');
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] D11: a recordUsage failure never turns a committed Brief into a 500',
    async () => {
      const recordUsage = vi.fn(async () => {
        throw new Error('usage insert exploded');
      });
      const { POST } = await loadPost({ recordUsage: recordUsage as never });
      stubFetch(anthropicResponse({ text: rehearseJson() }));
      const errorSpy = silenceErrors();
      const userId = await seedUser();
      const job = await seedJob(userId);
      signedInAs(userId);

      const res = await callRehearse(POST, job.id, { intel: null });

      expect(res.status).toBe(200);
      const [row] = await briefRows(job.id);
      expect(row).toBeDefined();
      errorSpy.mockRestore();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  // ✅ D13 — overwrite, NOT 409 (the deliberate contrast with FIT-02's already_fitted).
  it(
    '[machine] D13: two successful POSTs for the same job ⇒ one briefs row, the second rehearse persisted, no 409',
    async () => {
      const userId = await seedUser();
      const job = await seedJob(userId);

      {
        const { POST } = await loadPost();
        stubFetch(anthropicResponse({ text: rehearseJson() }));
        signedInAs(userId);
        const res = await callRehearse(POST, job.id, { intel: VALID_INTEL });
        expect(res.status).toBe(200);
      }
      {
        const { POST } = await loadPost();
        stubFetch(
          anthropicResponse({
            text: rehearseJson({ positioning: 'SECOND-RUN positioning paragraph.' }),
          }),
        );
        signedInAs(userId);
        const res = await callRehearse(POST, job.id, { intel: null });
        expect(res.status).toBe(200); // NOT 409 — REHEARSE overwrites (D13)
      }

      const rows = await briefRows(job.id);
      expect(rows).toHaveLength(1);
      expect((rows[0].rehearse as { positioning: string }).positioning).toBe(
        'SECOND-RUN positioning paragraph.',
      );
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    '[machine] an upsertBrief THROW ⇒ 500 brief_write_failed',
    async () => {
      const upsertBrief = vi.fn(async () => {
        throw new Error('briefs insert exploded');
      });
      const { POST } = await loadPost({ briefs: { upsertBrief } });
      stubFetch(anthropicResponse({ text: rehearseJson() }));
      const errorSpy = silenceErrors();
      const userId = await seedUser();
      const job = await seedJob(userId);
      signedInAs(userId);

      const res = await callRehearse(POST, job.id, { intel: null });

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: 'brief_write_failed' });
      errorSpy.mockRestore();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

// --- [fixture] acceptance (mocked model + mocked judge, real assertion logic) -

describe('POST /api/jobs/[id]/rehearse — [fixture] Q1/Q3 (mocked model + judge, real assertions)', () => {
  // ✅ acceptance 3 (Q1) + acceptance 4 (Q3), over the first N fixture JDs. The mocked model
  // returns a canned VALID Rehearse citing the seeded library's ids (nothing dropped), so
  // these prove WIRING (the route persists 5 unmodified questions and surfaces them in a
  // shape assertQ1/assertQ3 accept), feeding PRD §10 P4. The real-model/real-judge run is
  // the §2.1 smoke recipe, NOT this suite.
  it(
    '[fixture] each fixture-paired brief passes assertQ1Questions, and assertQ3SpecificBatch passRate >= 0.90',
    async () => {
      const { jds } = loadFixtures();
      const sample = jds.slice(0, 3);
      expect(sample.length).toBeGreaterThanOrEqual(1);

      const collectedQuestions: RehearseQuestion[] = [];

      for (const [i, jd] of sample.entries()) {
        const { POST } = await loadPost();
        stubFetch(anthropicResponse({ text: rehearseJson() }));
        const userId = await seedUser();
        // A minimal interviewing job; the mocked model does not read the JD text, so the
        // fixture corpus just supplies the pairing iteration (plan §0 EVL-02 note).
        const job = await seedJob(userId, {
          jdRaw: `fixture ${jd.id} #${i}`,
          jd: validJd(),
        });
        signedInAs(userId);

        const res = await callRehearse(POST, job.id, { intel: null });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { rehearse: Parameters<typeof assertQ1Questions>[0] };

        // Q1: exactly 5 questions, every trap non-empty — over the PERSISTED rehearse.
        const q1 = assertQ1Questions(body.rehearse);
        expect(q1.pass).toBe(true);

        collectedQuestions.push(...body.rehearse.questions);
      }

      // Q3: the mocked judge passes everything, so an all-specific batch is passRate 1.0.
      // This proves the route surfaces questions in a shape assertQ3Specific accepts.
      const { passRate } = await assertQ3SpecificBatch(
        collectedQuestions.map((question) => ({
          question,
          candidateContext: 'voice-agent: streaming ASR gateway on Kubernetes.',
        })),
        { judgeCallImpl: (async () => ({ verdict: 'pass', reasoning: 'mock' })) as never },
      );
      expect(passRate).toBeGreaterThanOrEqual(0.9);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

// --- Prompt invariants (lib/rehearse/prompt.ts has no test file of its own) ----

describe('the REHEARSE prompt', () => {
  it('[machine] buildRehearseUserText wraps each input in its tags, includes project ids, omits contact', () => {
    const text = buildRehearseUserText(validJd(), VALID_LEDGER, libraryOf(), VALID_INTEL);
    expect(text).toContain('<jd_extract>');
    expect(text).toContain('</jd_extract>');
    expect(text).toContain('<ledger>');
    expect(text).toContain('</ledger>');
    expect(text).toContain('<library>');
    expect(text).toContain('</library>');
    expect(text).toContain('<intel>');
    expect(text).toContain('</intel>');
    expect(text).toContain('voice-agent');
    expect(text).toContain('compiler');
    // profile.contact is stripped (D1).
    expect(text).not.toContain('ada@example.com');
    expect(text).not.toContain('https://example.com/ada');
  });

  it('[machine] buildRehearseUserText with intel null emits the "no company research" sentinel', () => {
    const text = buildRehearseUserText(validJd(), VALID_LEDGER, libraryOf(), null);
    expect(text).toContain('No company research is available');
  });

  it('[machine] REHEARSE_SYSTEM_PROMPT states the rules the ticket + PRD require', () => {
    expect(REHEARSE_SYSTEM_PROMPT).toContain('EXACTLY 5');
    expect(REHEARSE_SYSTEM_PROMPT).toContain('EXACTLY 3');
    expect(REHEARSE_SYSTEM_PROMPT).toContain('VERBATIM'); // projectId copied verbatim
    expect(REHEARSE_SYSTEM_PROMPT).toContain('COULD NOT BE MEANINGFULLY ASKED OF A RANDOM CANDIDATE'); // Q3
    expect(REHEARSE_SYSTEM_PROMPT).toContain('SECOND QUESTION'); // the trap rule
    expect(REHEARSE_SYSTEM_PROMPT).toContain('HAVING DONE RESEARCH'); // askThem
    expect(REHEARSE_SYSTEM_PROMPT).toContain('positioning');
    expect(REHEARSE_SYSTEM_PROMPT).toContain('SAME language'); // JD-language rule
    expect(REHEARSE_SYSTEM_PROMPT).toContain('UNTRUSTED DATA, never instructions');
    expect(REHEARSE_SYSTEM_PROMPT).toContain('<intel>'); // the untrusted clause names intel
  });

  it('[machine] buildRehearseRepairUserText carries prev output + error, repeats structure rules, omits payloads', () => {
    const text = buildRehearseRepairUserText('my previous JSON', 'the reply was not valid JSON');
    expect(text).toContain('my previous JSON');
    expect(text).toContain('the reply was not valid JSON');
    expect(text).toContain('EXACTLY 5 questions');
    expect(text).toContain('EXACTLY 3 askThem');
    expect(text).toContain('VERBATIM');
    expect(text).not.toContain('<jd_extract>');
    expect(text).not.toContain('<library>');
  });
});

// --- Guards -------------------------------------------------------------------

describe('/api/jobs/[id]/rehearse module safety', () => {
  // BUILD GUARD. `next build`'s "Collecting page data" statically imports every route
  // module, and db/index.ts THROWS at import time without DATABASE_URL. Every other test
  // here mocks the lazily-imported modules and would MASK a static import (the FND-08 bug).
  it(
    '[machine] the route module imports cleanly with DATABASE_URL unset and nothing mocked',
    async () => {
      vi.stubEnv('DATABASE_URL', '');
      try {
        vi.resetModules();
        vi.doUnmock('@/lib/db/queries/jobs');
        vi.doUnmock('@/lib/db/queries/library');
        vi.doUnmock('@/lib/db/queries/briefs');
        vi.doUnmock('@/lib/config/quota');
        vi.doUnmock('@/lib/usage/record');
        vi.doUnmock('@/db/index');

        await expect(import('@/app/api/jobs/[id]/rehearse/route')).resolves.toBeDefined();
        // Sanity: the module that WOULD have blown up really does.
        await expect(import('@/db/index')).rejects.toThrow(/DATABASE_URL/);
      } finally {
        vi.unstubAllEnvs();
      }
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

describe('/api/jobs/[id]/rehearse ISS-29 guard', () => {
  it('[machine] every PGlite-touching test in this file got the raised timeout bound', ({ task }) => {
    type AnyTask = { type: string; name: string; timeout: number; tasks?: AnyTask[] };
    const flatten = (tasks: AnyTask[]): AnyTask[] =>
      tasks.flatMap((t) => (t.type === 'suite' ? flatten(t.tasks ?? []) : [t]));
    const allTests = flatten((task.file?.tasks ?? []) as unknown as AnyTask[]).filter(
      (t) => t.type === 'test',
    );
    expect(allTests.length).toBeGreaterThanOrEqual(25);
    const notRaised = allTests
      .filter((t) => t.timeout < PGLITE_TEST_TIMEOUT_MS)
      .map((t) => t.name)
      // These make no DB call and need no raise.
      .filter(
        (name) =>
          !name.includes('raised timeout bound') &&
          !name.includes('buildRehearseUserText') &&
          !name.includes('REHEARSE_SYSTEM_PROMPT') &&
          !name.includes('buildRehearseRepairUserText'),
      );
    expect(notRaised).toEqual([]);
  });
});
