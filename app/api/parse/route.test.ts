import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
} from 'vitest';

import { loadFixtures } from '@/eval/fixtures';
import { Library } from '@/lib/schemas/entities';

// LIB-01 — the machine-checkable acceptance surface for POST /api/parse.
//
// The route reaches four modules: `@/auth` (via requireUserId), and — LAZILY, and
// that laziness is itself load-bearing — `@/lib/config/quota`,
// `@/lib/usage/record`, and `@/lib/parse/docx`. `@/auth` is mocked file-wide via
// vi.hoisted so the mock fn keeps a STABLE reference across each test's
// vi.resetModules(); quota/record are swapped per test with doMock + a fresh
// dynamic import, mirroring app/api/account/delete/route.test.ts.
//
// NO test here makes a real Anthropic call: every one stubs globalThis.fetch. A
// real call would be non-deterministic and would cost money on every CI run
// (~$0.03 — PRD §9). The compensating control for "does PARSE actually work
// against a real model, including the PDF document-input path" is the human-run
// recipe in lib/parse/manual-smoke.md, deliberately NOT part of `pnpm test`.

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock('@/auth', () => ({ auth: mockAuth }));

const TEST_USER_ID = 'user-abc-123';
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

type BreakerFn = () => Promise<{ tripped: boolean; spentTodayUsd: number; limitUsd: number }>;

const okBreaker: BreakerFn = async () => ({ tripped: false, spentTodayUsd: 1, limitUsd: 50 });

// Mirrors FND-10's RecordUsageEvent closely enough that `mock.calls[0][0]` is
// typed — asserting on `event.op` should be a compile-time-checked property
// access, not a cast through `Record<string, unknown>`.
type RecordedUsage = {
  userId: string;
  op: string;
  tokensIn: number;
  tokensOut: number;
  searches: number;
  durationMs: number;
};
type RecordUsageMock = Mock<(event: RecordedUsage) => Promise<void>>;
const makeRecordUsage = (): RecordUsageMock =>
  vi.fn<(event: RecordedUsage) => Promise<void>>(async () => {});

async function loadPost(opts: { breaker?: BreakerFn; recordUsage?: RecordUsageMock } = {}) {
  vi.resetModules();
  vi.doMock('@/lib/config/quota', () => ({ checkGlobalBreaker: opts.breaker ?? okBreaker }));
  vi.doMock('@/lib/usage/record', () => ({
    recordUsage: opts.recordUsage ?? makeRecordUsage(),
  }));
  const mod = await import('@/app/api/parse/route');
  return mod.POST;
}

// --- Request builders --------------------------------------------------------

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/parse', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function uploadRequest(bytes: Uint8Array, filename = 'resume.pdf', type = 'application/pdf'): Request {
  const form = new FormData();
  form.append('file', new File([bytes as BlobPart], filename, { type }));
  // Boundary content-type is set automatically by the FormData body.
  return new Request('http://localhost/api/parse', { method: 'POST', body: form });
}

function formTextRequest(fields: Record<string, string>): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new Request('http://localhost/api/parse', { method: 'POST', body: form });
}

// --- Anthropic response stubs -----------------------------------------------

function anthropicResponse(
  text: string,
  usage: { input_tokens: number; output_tokens: number } = {
    input_tokens: 1000,
    output_tokens: 2000,
  },
  stopReason = 'end_turn',
): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text }],
      usage,
      stop_reason: stopReason,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

// --- Canned model output, one per EVL-01 resume fixture -----------------------
//
// Every metric string below is copied VERBATIM out of the fixture it belongs to;
// tests 1–3 re-assert that verbatim-ness against the fixture text, which is what
// keeps these canned objects honest instead of decorative constants.

type CannedProject = {
  id: string;
  name: string;
  stage: string;
  role: string;
  stack: string[];
  summary: string;
  metrics: string[];
  tags: string[];
};

const CANNED: Record<string, { profile: { name: string }; projects: CannedProject[] }> = {
  'synthetic-junior': {
    profile: { name: 'Jordan Avery' },
    projects: [
      {
        id: 'trailmark',
        name: 'Trailmark — hiking route tracker',
        stage: 'shipped',
        role: 'Sole developer',
        stack: ['TypeScript', 'React', 'Node.js', 'Express', 'PostgreSQL'],
        summary:
          'Full-stack route logger. Chose a normalised Postgres schema over a document store because routes and waypoints are relational, and added server-side pagination when the list view got sluggish.',
        metrics: [
          '92% test coverage on the API layer',
          'page load under 1.5s on the route list',
        ],
        tags: ['full-stack', 'postgres'],
      },
      {
        id: 'pantry',
        name: 'Pantry — recipe suggestion tool',
        stage: 'unknown',
        role: 'Sole developer',
        stack: ['Python', 'Flask', 'SQLite'],
        summary:
          'Suggests recipes from ingredients on hand. Built a scoring function ranking recipes by pantry-item overlap, refactored from nested loops into a single set-intersection pass.',
        metrics: [], // "none reported" ⇒ [] — PRD §5.6's explicitly valid empty state
        tags: ['side-project'],
      },
    ],
  },
  'synthetic-mid': {
    profile: { name: 'Sam Delacroix' },
    projects: [
      {
        id: 'booking-engine-rewrite',
        name: 'Booking engine rewrite',
        stage: 'shipped',
        role: 'Lead',
        stack: ['TypeScript', 'Node.js', 'PostgreSQL', 'Redis'],
        summary:
          'Replaced a per-request database scan with a Redis-backed availability cache invalidated on booking events, trading staleness risk for latency, plus idempotency keys so a retried booking cannot double-book.',
        metrics: [
          'p95 latency reduced from 800ms to 110ms',
          'double-booking incidents down to zero',
        ],
        tags: ['performance', 'caching'],
      },
      {
        id: 'reporting-exports-pipeline',
        name: 'Reporting exports pipeline',
        stage: 'shipped',
        role: 'Engineer',
        stack: ['Python', 'Celery', 'PostgreSQL', 'AWS S3'],
        summary:
          'Moved CSV/PDF export generation off the web tier onto a Celery queue with progress tracking, and made exports resumable after a worker crash by checkpointing row offsets.',
        metrics: [
          'handled exports up to 2M rows without timeouts',
          '30% drop in web-tier error rate',
        ],
        tags: ['async', 'pipeline'],
      },
      {
        id: 'split',
        name: 'Split — shared-expenses side project',
        stage: 'unknown',
        role: 'Sole developer',
        stack: ['TypeScript', 'Next.js', 'SQLite'],
        summary:
          'Group trip expense splitter. Modelled balances as an append-only ledger of transactions rather than mutable totals so the running balance stays auditable.',
        metrics: [],
        tags: ['side-project'],
      },
    ],
  },
  'synthetic-senior': {
    profile: { name: 'Riley Okonkwo' },
    projects: [
      {
        id: 'double-entry-ledger-platform',
        name: 'Double-entry ledger platform',
        stage: 'shipped',
        role: 'Tech lead',
        stack: ['Go', 'PostgreSQL', 'Kafka', 'Kubernetes'],
        summary:
          'Immutable double-entry ledger that is the source of truth for all balances. Chose an append-only event model with derived balance projections over mutable-row accounting, with per-account serialisable transactions.',
        metrics: [
          '99.99% availability over 18 months',
          'reconciliation discrepancies reduced to zero',
          '4,000 transactions/sec sustained',
        ],
        tags: ['distributed-systems', 'fintech'],
      },
      {
        id: 'cross-region-failover',
        name: 'Cross-region failover for the ledger',
        stage: 'shipped',
        role: 'Lead',
        stack: ['Go', 'PostgreSQL', 'Kubernetes', 'Terraform'],
        summary:
          'Made the ledger survive a full regional outage via asynchronous replication with bounded, monitored lag and a rehearsed failover runbook, choosing an RPO of seconds over synchronous cross-region commits.',
        metrics: ['recovery time objective cut from 45 minutes to under 4 minutes'],
        tags: ['reliability'],
      },
      {
        id: 'metadata-service-redesign',
        name: 'Metadata service redesign',
        stage: 'shipped',
        role: 'Engineer',
        stack: ['Java', 'Cassandra', 'Redis'],
        summary:
          'Rebuilt the video-metadata service under peak read load with a read-through cache and denormalised hot access paths, load-tested against replayed production traffic before rollout.',
        metrics: ['peak read latency down 60%', 'database load reduced by roughly half'],
        tags: ['caching', 'scale'],
      },
      {
        id: 'internal-service-scaffolding-cli',
        name: 'Internal service-scaffolding CLI',
        stage: 'unknown',
        role: 'Driver',
        stack: ['Go'],
        summary:
          'Generates a new Go service with logging, metrics, tracing, and CI already wired in, encoding team conventions so new services start on the paved road.',
        metrics: [],
        tags: ['developer-experience'],
      },
    ],
  },
};

function cannedReply(fixtureId: string, resumeMd: string): string {
  return JSON.stringify({ resumeMd, draftLibrary: CANNED[fixtureId] });
}

// A minimal always-valid reply for tests that are not about content.
const VALID_LIBRARY = CANNED['synthetic-mid'];
const VALID_REPLY = JSON.stringify({ resumeMd: '# Sam Delacroix', draftLibrary: VALID_LIBRARY });

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
  mockAuth.mockResolvedValue({ user: { id: TEST_USER_ID } } as never);
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
  mockAuth.mockReset();
  vi.unstubAllEnvs();
});

describe('POST /api/parse — fixture corpus (PRD §10 P1: 3 份 fixture 简历解析正确)', () => {
  const { resumes } = loadFixtures();

  // Guard: a silently-empty corpus would make the three tests below vacuous.
  it('[fixture] the EVL-01 corpus really has the 3 resumes these tests iterate', () => {
    expect(resumes.map((r) => r.id).sort()).toEqual([
      'synthetic-junior',
      'synthetic-mid',
      'synthetic-senior',
    ]);
  });

  for (const fixtureId of ['synthetic-junior', 'synthetic-mid', 'synthetic-senior']) {
    it(`[fixture] parses ${fixtureId} into a schema-valid draftLibrary with real metrics`, async () => {
      const fixture = resumes.find((r) => r.id === fixtureId);
      expect(fixture).toBeDefined();
      const resumeText = fixture!.text;

      fetchSpy.mockResolvedValue(anthropicResponse(cannedReply(fixtureId, resumeText)));
      const POST = await loadPost();
      const res = await POST(jsonRequest({ text: resumeText }));

      expect(res.status).toBe(200);
      const body = await res.json();

      // FND-02's Library schema is the acceptance bar, re-parsed here rather than
      // trusting the route's own validation.
      const parsed = Library.safeParse(body.draftLibrary);
      expect(parsed.success).toBe(true);
      expect(parsed.data!.projects.length).toBeGreaterThanOrEqual(1);
      expect(body.resumeMd).toBe(resumeText);

      // P2 "数字永不虚构": every metric must appear LITERALLY in the source.
      for (const project of parsed.data!.projects) {
        for (const metric of project.metrics) {
          expect(
            resumeText.includes(metric),
            `metric ${JSON.stringify(metric)} is not verbatim in ${fixtureId}`,
          ).toBe(true);
        }
      }
    });
  }

  it('[machine] an empty metrics array survives the route unchanged (valid, displayed state)', async () => {
    const resumeText = resumes.find((r) => r.id === 'synthetic-mid')!.text;
    fetchSpy.mockResolvedValue(anthropicResponse(cannedReply('synthetic-mid', resumeText)));
    const POST = await loadPost();
    const res = await POST(jsonRequest({ text: resumeText }));

    const body = await res.json();
    const emptyMetricProjects = body.draftLibrary.projects.filter(
      (p: { metrics: string[] }) => p.metrics.length === 0,
    );
    expect(emptyMetricProjects.length).toBeGreaterThanOrEqual(1);
  });
});

describe('POST /api/parse — auth and cost controls', () => {
  it('[machine] returns 401 and spends nothing when unauthenticated', async () => {
    mockAuth.mockResolvedValue(null as never);
    const recordUsage = makeRecordUsage();
    const breaker = vi.fn(okBreaker);

    const POST = await loadPost({ breaker, recordUsage });
    const res = await POST(jsonRequest({ text: 'some resume' }));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(breaker).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('[machine] returns 503 BEFORE any Anthropic call when the global breaker is tripped', async () => {
    const recordUsage = makeRecordUsage();
    const POST = await loadPost({
      breaker: async () => ({ tripped: true, spentTodayUsd: 50, limitUsd: 50 }),
      recordUsage,
    });
    const res = await POST(jsonRequest({ text: 'some resume' }));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: 'global_breaker_tripped' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('[machine] fails CLOSED with 503 when checkGlobalBreaker THROWS (unset env)', async () => {
    // FND-06 throws when GLOBAL_DAILY_SPEND_LIMIT_USD is unset/blank/non-numeric.
    // No paid call may go out without a configured breaker.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const POST = await loadPost({
      breaker: async () => {
        throw new Error('GLOBAL_DAILY_SPEND_LIMIT_USD is not set (or not numeric).');
      },
    });
    const res = await POST(jsonRequest({ text: 'some resume' }));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: 'global_breaker_tripped' });
    expect(fetchSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('[machine] a successful parse calls recordUsage EXACTLY once with op:parse', async () => {
    const recordUsage = makeRecordUsage();
    fetchSpy.mockResolvedValue(
      anthropicResponse(VALID_REPLY, { input_tokens: 1234, output_tokens: 4321 }),
    );

    const POST = await loadPost({ recordUsage });
    const res = await POST(jsonRequest({ text: 'a resume' }));

    expect(res.status).toBe(200);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    const event = recordUsage.mock.calls[0][0];
    expect(event.op).toBe('parse');
    expect(event.userId).toBe(TEST_USER_ID);
    expect(event.searches).toBe(0);
    expect(event.tokensIn).toBe(1234);
    expect(event.tokensOut).toBe(4321);
    expect(typeof event.durationMs).toBe('number');
  });
});

describe('POST /api/parse — input handling (解析失败 → 引导粘贴纯文本)', () => {
  it('[machine] an EMPTY uploaded file returns 422 parse_failed, never an exception', async () => {
    const POST = await loadPost();
    const res = await POST(uploadRequest(new Uint8Array(0)));

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({ error: 'parse_failed', suggestPaste: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('[machine] a GARBAGE buffer declared application/pdf returns 422 parse_failed', async () => {
    // Content sniffing, not the client-declared type, is what decides the path.
    const POST = await loadPost();
    const res = await POST(uploadRequest(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05])));

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({ error: 'parse_failed', suggestPaste: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('[machine] a real PDF magic-byte upload takes the document-input path', async () => {
    fetchSpy.mockResolvedValue(anthropicResponse(VALID_REPLY));
    const pdfBytes = new TextEncoder().encode('%PDF-1.7\n%fake pdf body\n');

    const POST = await loadPost();
    const res = await POST(uploadRequest(pdfBytes));

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    const blocks = sent.messages[0].content;
    expect(blocks[0].type).toBe('document');
    expect(blocks[0].source.media_type).toBe('application/pdf');
    expect(Buffer.from(blocks[0].source.data, 'base64').toString('latin1')).toBe(
      Buffer.from(pdfBytes).toString('latin1'),
    );
  });

  it('[machine] a ZIP-magic (DOCX-shaped) upload that mammoth rejects returns 422', async () => {
    // No real .docx fixture may be added here (fixtures/** is 02-evaluation's
    // file-scope), so CI covers the DOCX FAILURE path only; the DOCX happy path is
    // covered by lib/parse/manual-smoke.md. Flagged rather than faked.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const zipGarbage = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x11, 0x22, 0x33, 0x44]);

    const POST = await loadPost();
    const res = await POST(uploadRequest(zipGarbage, 'resume.docx'));

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({ error: 'parse_failed', suggestPaste: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('[machine] an OVERSIZE upload is rejected with 422 before any spend', async () => {
    const tooBig = new Uint8Array(10 * 1024 * 1024 + 1);
    tooBig.set(new TextEncoder().encode('%PDF-'), 0); // valid magic, still too big

    const POST = await loadPost();
    const res = await POST(uploadRequest(tooBig));

    expect(res.status).toBe(422);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('[machine] OVERSIZE pasted text is rejected with 422 before any spend', async () => {
    const POST = await loadPost();
    const res = await POST(jsonRequest({ text: 'x'.repeat(100_001) }));

    expect(res.status).toBe(422);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('[machine] blank / missing / wrong-typed text bodies return 422 with no spend', async () => {
    const POST = await loadPost();
    for (const body of [{ text: '   ' }, {}, { text: 42 }, { notText: 'hi' }]) {
      const res = await POST(jsonRequest(body));
      expect(res.status).toBe(422);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('[machine] an unsupported content-type, and multipart with neither file nor text, return 422', async () => {
    const POST = await loadPost();

    const plain = new Request('http://localhost/api/parse', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'a resume',
    });
    expect((await POST(plain)).status).toBe(422);

    const emptyForm = await POST(formTextRequest({ irrelevant: 'field' }));
    expect(emptyForm.status).toBe(422);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('[machine] multipart `text` field is accepted as the pasted-text path', async () => {
    fetchSpy.mockResolvedValue(anthropicResponse(VALID_REPLY));
    const POST = await loadPost();
    const res = await POST(formTextRequest({ text: 'a pasted resume' }));

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('[machine] when both `file` and `text` are sent, a failing file 422s (no silent fallback)', async () => {
    const form = new FormData();
    form.append('file', new File([new Uint8Array([1, 2, 3, 4])], 'resume.pdf'));
    form.append('text', 'a perfectly good pasted resume');
    const req = new Request('http://localhost/api/parse', { method: 'POST', body: form });

    const POST = await loadPost();
    const res = await POST(req);

    expect(res.status).toBe(422);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/parse — model-reply validation and the single repair retry', () => {
  it('[machine] repairs a malformed-JSON first reply and succeeds on the second', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const recordUsage = makeRecordUsage();
    fetchSpy
      .mockResolvedValueOnce(
        anthropicResponse('here you go: {"resumeMd": "oops', {
          input_tokens: 1000,
          output_tokens: 2000,
        }),
      )
      .mockResolvedValueOnce(
        anthropicResponse(VALID_REPLY, { input_tokens: 300, output_tokens: 400 }),
      );

    const POST = await loadPost({ recordUsage });
    const res = await POST(jsonRequest({ text: 'a resume' }));

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // The repair call must NOT re-send the source (paid input tokens).
    const repairBody = JSON.parse(fetchSpy.mock.calls[1][1]!.body as string);
    expect(JSON.stringify(repairBody)).not.toContain('a resume');
    // Both calls were paid for — the recorded row sums them.
    expect(recordUsage).toHaveBeenCalledTimes(1);
    const event = recordUsage.mock.calls[0][0];
    expect(event.tokensIn).toBe(1300);
    expect(event.tokensOut).toBe(2400);
    errorSpy.mockRestore();
  });

  it('[machine] repairs a Zod-INVALID (not merely malformed) first reply', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const badId = JSON.stringify({
      resumeMd: '# Sam',
      draftLibrary: {
        profile: { name: 'Sam Delacroix' },
        projects: [{ ...VALID_LIBRARY.projects[0], id: 'Voice Agent' }], // not kebab-case
      },
    });
    fetchSpy
      .mockResolvedValueOnce(anthropicResponse(badId))
      .mockResolvedValueOnce(anthropicResponse(VALID_REPLY));

    const POST = await loadPost();
    const res = await POST(jsonRequest({ text: 'a resume' }));

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // The repair prompt must carry the Zod issue path so the model can act on it.
    const repairBody = JSON.parse(fetchSpy.mock.calls[1][1]!.body as string);
    expect(JSON.stringify(repairBody)).toContain('projects.0.id');
    errorSpy.mockRestore();
  });

  it('[machine] gives up with 422 after exactly ONE repair — never a third call', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const recordUsage = makeRecordUsage();
    // A FRESH Response per call: a Response body can only be read once, so a
    // reused instance would make the second attempt fail as a transport error and
    // this test would pass for the wrong reason.
    fetchSpy.mockImplementation(async () => anthropicResponse('not json at all'));

    const POST = await loadPost({ recordUsage });
    const res = await POST(jsonRequest({ text: 'a resume' }));

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({ error: 'parse_failed', suggestPaste: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // Documented gap (plan §5 Q1): a paid-but-failed call records no usage row.
    expect(recordUsage).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('[machine] an Anthropic HTTP 500 returns 422 with NO repair retry', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchSpy.mockResolvedValue(new Response('upstream boom', { status: 500 }));

    const POST = await loadPost();
    const res = await POST(jsonRequest({ text: 'a resume' }));

    expect(res.status).toBe(422);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('[machine] a fetch rejection (network/timeout) returns 422 and logs no PII', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchSpy.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));

    const POST = await loadPost();
    const res = await POST(jsonRequest({ text: 'SECRET RESUME TEXT' }));

    expect(res.status).toBe(422);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain('SECRET RESUME TEXT');
    errorSpy.mockRestore();
  });

  it('[machine] a TRUNCATED reply (stop_reason:max_tokens) is never a silent success', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Syntactically valid JSON, but the model ran out of room — must not pass.
    // Fresh Response per call (see the one-repair test) so the repair attempt is
    // genuinely rejected for truncation, not for a re-read body.
    fetchSpy.mockImplementation(async () =>
      anthropicResponse(VALID_REPLY, { input_tokens: 10, output_tokens: 10 }, 'max_tokens'),
    );

    const POST = await loadPost();
    const res = await POST(jsonRequest({ text: 'a resume' }));

    expect(res.status).toBe(422);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });

  it('[machine] tolerates a ```json code fence around an otherwise valid reply', async () => {
    fetchSpy.mockResolvedValue(anthropicResponse('```json\n' + VALID_REPLY + '\n```'));

    const POST = await loadPost();
    const res = await POST(jsonRequest({ text: 'a resume' }));

    expect(res.status).toBe(200);
    // A cosmetic fence must not burn a second paid call.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('[machine] never returns raw model text — only ParseResult-validated fields', async () => {
    fetchSpy.mockResolvedValue(
      anthropicResponse(
        JSON.stringify({
          resumeMd: '# Sam',
          draftLibrary: VALID_LIBRARY,
          injectedExtra: 'should not survive the Zod boundary',
        }),
      ),
    );

    const POST = await loadPost();
    const res = await POST(jsonRequest({ text: 'a resume' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['draftLibrary', 'resumeMd']);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('LIB-01 structural guards', () => {
  it('[machine] no file-write or blob-storage API is referenced anywhere in this ticket’s code', async () => {
    // PRD §8.1 "原始文件解析后即弃、不落盘" — and app/(legal)/privacy/page.tsx
    // already publishes that promise, so a file write here would make a live legal
    // page false. Enforced mechanically rather than by review discipline.
    const parseDir = path.join(repoRoot, 'lib', 'parse');
    const files = [
      path.join(repoRoot, 'app', 'api', 'parse', 'route.ts'),
      ...readdirSync(parseDir)
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
        .map((f) => path.join(parseDir, f)),
    ];

    // A glob that matches nothing must FAIL, not pass vacuously.
    expect(files.length).toBeGreaterThanOrEqual(6);

    const forbidden: Array<[string, RegExp]> = [
      ['fs module import', /from\s+['"](node:)?fs(\/promises)?['"]/],
      ['fs require', /require\(['"](node:)?fs/],
      ['writeFile', /\bwriteFile(Sync)?\s*\(/],
      ['appendFile', /\bappendFile(Sync)?\s*\(/],
      ['createWriteStream', /\bcreateWriteStream\s*\(/],
      [
        'blob/object storage SDK',
        /@vercel\/blob|@aws-sdk|aws-sdk|@google-cloud\/storage|cloudinary/,
      ],
    ];

    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const [label, pattern] of forbidden) {
        if (pattern.test(source)) violations.push(`${path.relative(repoRoot, file)}: ${label}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('[machine] the route module imports cleanly with DATABASE_URL unset (build guard)', async () => {
    // `next build`'s "Collecting page data" statically imports every route module,
    // and db/index.ts THROWS at import time without DATABASE_URL. quota.ts and
    // record.ts both import it, so the route must reach them LAZILY. Every other
    // test in this file mocks those two modules and would therefore MASK a static
    // import — this one deliberately un-mocks them. (FND-08 shipped exactly this
    // bug and had to bounce-fix it.)
    vi.stubEnv('DATABASE_URL', '');
    vi.resetModules();
    vi.doUnmock('@/lib/config/quota');
    vi.doUnmock('@/lib/usage/record');

    await expect(import('@/app/api/parse/route')).resolves.toBeDefined();

    // Sanity: the module that would have blown up really does blow up, so this
    // test cannot pass because DATABASE_URL happened to be set.
    await expect(import('@/db/index')).rejects.toThrow(/DATABASE_URL/);
  });
});
