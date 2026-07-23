import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireUserId, UnauthorizedError } from '@/lib/auth/session';
import { PRIMARY_MODEL } from '@/lib/config/models';
import {
  buildReadRepairUserText,
  buildReadUserText,
  READ_MAX_TOKENS,
  READ_SYSTEM_PROMPT,
} from '@/lib/read/prompt';
import { JdExtract } from '@/lib/schemas/pipeline';

// FIT-01 Deliverable 3 — job creation: the READ stage plus the row it persists.
//
// PRD §5.1 (READ row): 新建 job · jdRaw → JdExtract · "requirements ≤ 11、weight
// 1–3（3 = 没有就不招）、每条打 category；atsKeywords 列表；subtext ≤ 3" ·
// "JSON 修复重试 1 次 → 报错". The ≤ 11 / weight / category / ≤ 3 constraints are
// enforced by FND-03's JdExtract schema, not by hand here.
//
// PRD §5.7 (server-side, not just a UI affordance): "无库时禁止新建 job，CTA 引导
// 导入简历——垃圾进垃圾出，库太薄时产出通用结果等于自毁定位". Step 3 below is that
// gate. FIT-03 will also gate the UI; both are required, and this one is the real
// one — an API client that skips the UI still cannot create a job without a library.
//
// QUOTA IS CHARGED EXACTLY ONCE, HERE, for the whole two-call "Fit" operation
// (04-fit/README.md's decision, carried from breakdown-plan.md §6 #8). FIT-02's
// POST /api/jobs/[id]/fit deliberately does NOT re-check it. Two vocabularies are in
// play and must not be conflated: the QUOTA BUCKET is 'fit' (FND-06's DAILY_QUOTA
// key, PRD §8.3 "10 fit"/day) while the USAGE-EVENT op is 'read' (FND-04's UsageOp
// has no 'fit' value — only the six pipeline-stage names). FND-06's
// QUOTA_OP_TO_USAGE_OP maps fit -> 'read' and its comment requires this ticket to
// re-confirm that mapping: RE-CONFIRMED, and honored below. Changing either side
// without the other silently breaks quota counting with no compile-time signal.
//
// KNOWN, ACCEPTED (docs/plans/FIT-01.md §4):
//   R2  FND-06's checkAndIncrementQuota only COUNTS; the row that consumes quota is
//       recordUsage's insert. Two simultaneous POSTs can both pass the check, so a
//       user can momentarily exceed 10/day by one (~$0.04). Accepted by FND-06's own
//       Feedback obligation #2 — do NOT "fix" it here with a lock or an atomic
//       counter; that is a hardening decision needing Horace's sign-off.
//   R15 No dedupe: two POSTs with the same JD create two jobs. No PRD requirement
//       says otherwise.
//   R4  A client that creates a job and never calls FIT-02 has spent quota for no
//       report and leaves a jd-only row forever. FIT-03's auto-trigger mitigates it;
//       accumulating evidence of real abandonment is a reportable finding (ticket
//       Feedback obligation #2), not grounds to silently move where quota is charged.
//
// BUILD-TIME SAFETY (the FND-08 bug class): `next build`'s "Collecting page data"
// phase statically imports every app/api/**/route.ts, and db/index.ts THROWS at
// import time when DATABASE_URL is unset (an intentional, tested FND-05 fail-fast).
// `@/lib/config/quota` and `@/lib/usage/record` both import `@/db/index` STATICALLY,
// so they — and the two query modules — are imported LAZILY inside the handler,
// never at module top level. Guarded by a test that imports this module with
// DATABASE_URL blank and no mocks. `@/lib/auth/session`, `@/lib/config/models`,
// `@/lib/read/prompt`, `@/lib/schemas/*` and `zod` are safe statically.
//
// WIRE CONTRACT — FIT-02 and FIT-03 code against this, do not improvise:
//
//   POST /api/jobs   Content-Type: application/json
//     body { "jdRaw": string, "company": string, "role": string }
//
//     201 <the created job>                                Cache-Control: no-store
//         { id, userId, company, role, status:"screening", jdRaw, jd:JdExtract,
//           ledger:null, fit:null, createdAt, updatedAt }
//     400 { "error":"invalid_body", "issues": string[] }   issue PATHS + messages,
//                                                          never the offending values
//     401 { "error":"Unauthorized" }
//     403 { "error":"no_library" }                         PRD §5.7 server-side gate
//     422 { "error":"read_failed" }                        READ unusable after 1 repair
//     429 { "error":"quota_exceeded", "op":"fit", "resetAt": number }
//     500 { "error":"library_check_failed" | "job_write_failed" }
//     503 { "error":"global_breaker_tripped" | "quota_check_failed" }
//
// `ledger` and `fit` are present as explicit NULLs rather than omitted, so FIT-03
// can branch on `job.fit === null` without key-existence checks. That is the API
// face of docs/plans/FIT-01.md §0.1 R-A: the row is transiently incomplete between
// this call and FIT-02's, and the client is told so explicitly.
//
// Only POST is exported — Next.js answers every other method with 405 by itself.
// There is no GET /api/jobs list route in v1: FIT-03 reads the list server-side
// through a query helper, not over HTTP.
//
// CSRF: auth.config.ts sets no cookie override, so Auth.js v5 defaults apply
// (httpOnly, sameSite: 'lax'). A cross-site POST carries no session cookie and gets
// a 401 before any spend — same posture LIB-01/LIB-02 documented. No extra token.
//
// LOGGING: never log `jdRaw`, the parsed `jd`, raw model text, request headers (they
// carry ANTHROPIC_API_KEY), or a raw Drizzle/pg error object. A JD often carries the
// user's own annotations, and driver errors echo statement parameters. Status codes,
// error name/message, Zod issue PATHS and lengths only.

export const runtime = 'nodejs';
// Vercel Hobby ceiling. A READ call is a few seconds; the ceiling is the safe
// declaration, and ANTHROPIC_TIMEOUT_MS below stays under it on purpose.
export const maxDuration = 60;

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
// Below `maxDuration`, so a hung upstream surfaces as our own 422 rather than a
// platform 504 with no error contract.
const ANTHROPIC_TIMEOUT_MS = 45_000;
// ~12k tokens of input ≈ a couple of cents. A long JD is ~6k chars. This is the
// per-call spend cap; the per-user/day cap is the `fit` quota and the org/day cap is
// the global breaker. Those three are the complete DoS/cost backstop — adding a
// fourth limiter is a PRD change, not a silent addition here.
const MAX_JD_CHARS = 50_000;
const MAX_NAME_CHARS = 200;

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

// `z.object` STRIPS unknown keys, and that is the trust boundary: a client-sent
// `userId`/`id`/`status`/`ledger`/`fit` is silently dropped and can never reach a
// query (pinned by a test). `userId` comes exclusively from the session; `id`,
// `createdAt` and `updatedAt` are server-generated in db/schema.ts.
const CreateJobBody = z.object({
  jdRaw: z.string().trim().min(1).max(MAX_JD_CHARS),
  company: z.string().trim().min(1).max(MAX_NAME_CHARS),
  role: z.string().trim().min(1).max(MAX_NAME_CHARS),
});

// Postgres rejects U+0000 in BOTH `text` ("invalid byte sequence for encoding
// UTF8: 0x00") and `jsonb`. An authenticated client can send one inside JSON, so
// without this guard a one-character payload is an unhandled 500. Also applied to
// the model's PARSED OUTPUT (validateCall), which lands in a jsonb column.
const NUL = String.fromCharCode(0);
function hasNulByte(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(NUL);
  if (Array.isArray(value)) return value.some(hasNulByte);
  if (value && typeof value === 'object') return Object.values(value).some(hasNulByte);
  return false;
}

type AnthropicCall = {
  text: string;
  tokensIn: number;
  tokensOut: number;
  truncated: boolean;
};

function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

function invalidBody(issues: string[]): NextResponse {
  return NextResponse.json({ error: 'invalid_body', issues }, { status: 400 });
}

/** PRD §5.1's READ failure policy: "JSON 修复重试 1 次 → 报错". */
function readFailed(): NextResponse {
  return NextResponse.json({ error: 'read_failed' }, { status: 422 });
}

/**
 * One Anthropic Messages call. Returns `null` on any transport/HTTP/timeout failure
 * — the caller converts that to 422 WITHOUT a repair retry (a 429/500/timeout is not
 * a JSON problem; a second paid call cannot help).
 *
 * Uses the global `fetch` with no injection seam, deliberately (same choice as
 * app/api/parse/route.ts): tests stub `globalThis.fetch`, and a `fetchImpl` option on
 * a request handler would be a live seam in production code existing only for tests.
 */
async function callAnthropic(userText: string): Promise<AnthropicCall | null> {
  try {
    const res = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: PRIMARY_MODEL,
        max_tokens: READ_MAX_TOKENS,
        system: READ_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
      }),
      signal: AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error('[jobs] anthropic returned', res.status);
      return null;
    }

    const data = await res.json();
    const blocks: unknown = data?.content;
    const text = Array.isArray(blocks)
      ? blocks
          .filter((b) => b?.type === 'text' && typeof b?.text === 'string')
          .map((b) => b.text as string)
          .join('')
      : '';

    return {
      text,
      tokensIn: Number(data?.usage?.input_tokens ?? 0),
      tokensOut: Number(data?.usage?.output_tokens ?? 0),
      truncated: data?.stop_reason === 'max_tokens',
    };
  } catch (err) {
    console.error('[jobs] anthropic call failed', {
      name: err instanceof Error ? err.name : 'unknown',
    });
    return null;
  }
}

/**
 * Pulls the JSON object out of a model reply: strips an optional code fence, then
 * slices from the first `{` to the last `}`. The prompt forbids fences; this
 * tolerates one anyway rather than burning a paid repair call on a cosmetic
 * violation.
 */
function extractJsonObject(text: string): unknown | null {
  const unfenced = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Validates one model reply. Returns the parsed `JdExtract`, or an `errorSummary`
 * phrased in terms the model can act on in the single repair turn.
 */
function validateCall(
  call: AnthropicCall,
): { ok: true; value: JdExtract } | { ok: false; errorSummary: string } {
  if (call.truncated) {
    return { ok: false, errorSummary: 'the reply was cut off before the JSON ended' };
  }
  const json = extractJsonObject(call.text);
  if (json === null) {
    return { ok: false, errorSummary: 'the reply was not valid JSON' };
  }
  const parsed = JdExtract.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      errorSummary: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }

  // THIS TICKET'S OWN ADDITION, not something FND-03 enforces: JdExtract requires
  // `requirements[].id` to be a string but does NOT require the ids to be unique or
  // non-empty. They are the join key FIT-02's Binding.requirementId / Gap
  // .requirementId point at, and FND-07's requirement-coverage check counts them —
  // two requirements sharing an id makes that coverage silently wrong with no
  // schema-level signal. Cheaper to catch here, in the one repair turn we already
  // pay for, than to persist a corrupt jd.
  const ids = parsed.data.requirements.map((r) => r.id);
  if (ids.some((id) => id.trim() === '')) {
    return { ok: false, errorSummary: 'every requirements[].id must be a non-empty string' };
  }
  if (new Set(ids).size !== ids.length) {
    return {
      ok: false,
      errorSummary: 'requirements[].id values must be unique within the reply (r1, r2, r3, ...)',
    };
  }

  // Defensive: a NUL byte anywhere in the extracted object would be rejected by the
  // jsonb column at insert time, i.e. an unhandled 500 instead of a repairable 422.
  if (hasNulByte(parsed.data)) {
    return { ok: false, errorSummary: 'the reply contained a NUL character' };
  }

  return { ok: true, value: parsed.data };
}

export async function POST(req: Request): Promise<NextResponse> {
  const startedAt = Date.now();

  // 1) Auth FIRST — before the body is read, before any DB access, before any spend.
  //    `userId` comes EXCLUSIVELY from the session (PRD §8.3 trust boundary).
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    if (e instanceof UnauthorizedError) return unauthorized();
    throw e;
  }

  // 2) Body. Malformed JSON / wrong content-type must land in the SAME 400, never an
  //    unhandled throw. No DB call and no Anthropic call happens on any 400 path.
  const body: unknown = await req.json().catch(() => null);
  const parsed = CreateJobBody.safeParse(body);
  if (!parsed.success) {
    // Paths + messages only — never the offending VALUES (they are the user's JD).
    return invalidBody(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  if (hasNulByte(parsed.data)) {
    return invalidBody(['body: contains a NUL character']);
  }
  const { jdRaw, company, role } = parsed.data;

  // 3) PRD §5.7's gate, server-side: no library ⇒ no job. ZERO Anthropic calls and
  //    ZERO DB writes on this path (an acceptance item asserts exactly that).
  //
  //    A THROW here is NOT a 403: hasLibrary() throws when the stored library jsonb
  //    has drifted (LIB-02's loud-failure policy). Reporting that as 'no_library'
  //    would tell a user who HAS a library to go import another one — a wrong CTA on
  //    top of a real bug. It is a 500.
  try {
    const { hasLibrary } = await import('@/lib/db/queries/library');
    if (!(await hasLibrary(userId))) {
      return NextResponse.json({ error: 'no_library' }, { status: 403 });
    }
  } catch (err) {
    console.error('[jobs] library check failed', {
      userId,
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
    return NextResponse.json({ error: 'library_check_failed' }, { status: 500 });
  }

  // 4) Quota, EXACTLY ONCE, before any paid call — the `fit` bucket for the whole
  //    two-call Fit operation (see the header). A THROW fails CLOSED with a 503: no
  //    paid call may go out without a working counter.
  //
  //    The lazy import lives INSIDE the try: `@/lib/config/quota` statically imports
  //    `@/db/index`, so a misconfigured environment makes the IMPORT itself throw,
  //    and that must fail closed like any other quota failure rather than escape as
  //    an unhandled 500.
  let checkGlobalBreaker: (typeof import('@/lib/config/quota'))['checkGlobalBreaker'];
  try {
    const quotaModule = await import('@/lib/config/quota');
    checkGlobalBreaker = quotaModule.checkGlobalBreaker;
    const quota = await quotaModule.checkAndIncrementQuota(userId, 'fit');
    if (!quota.allowed) {
      return NextResponse.json(
        { error: 'quota_exceeded', op: 'fit', resetAt: quota.resetAt },
        { status: 429 },
      );
    }
  } catch (err) {
    console.error('[jobs] quota check failed; failing closed', {
      userId,
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
    return NextResponse.json({ error: 'quota_check_failed' }, { status: 503 });
  }

  // 5) Global spend breaker (PRD §8.3 "全局日花费熔断阈值"). A THROW returns the SAME
  //    503 as a tripped breaker, exactly as app/api/parse/route.ts does and for the
  //    same reason: the client cannot act differently on "tripped" vs
  //    "misconfigured", and the operator sees the real reason in the log.
  try {
    const breaker = await checkGlobalBreaker();
    if (breaker.tripped) {
      return NextResponse.json({ error: 'global_breaker_tripped' }, { status: 503 });
    }
  } catch (err) {
    console.error('[jobs] global breaker check failed; failing closed', {
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
    return NextResponse.json({ error: 'global_breaker_tripped' }, { status: 503 });
  }

  // 6) The paid call. Transport failure → 422 with NO repair retry.
  const first = await callAnthropic(buildReadUserText(jdRaw));
  if (!first) return readFailed();

  let validated = validateCall(first);
  let repair: AnthropicCall | null = null;

  // 7) Exactly ONE repair retry (PRD §5.1), covering truncation, invalid JSON, Zod
  //    failures and duplicate requirement ids alike. NEVER a second one, and a
  //    partially-valid reply is never persisted.
  if (!validated.ok) {
    console.error('[jobs] first READ reply unusable; attempting one repair', {
      stage: 'repair',
      reason: validated.errorSummary.slice(0, 200),
      outputLength: first.text.length,
    });
    repair = await callAnthropic(buildReadRepairUserText(first.text, validated.errorSummary));
    if (!repair) return readFailed();
    validated = validateCall(repair);
    if (!validated.ok) {
      console.error('[jobs] READ repair reply also unusable; giving up', {
        stage: 'repair',
        reason: validated.errorSummary.slice(0, 200),
        outputLength: repair.text.length,
      });
      return readFailed();
    }
  }

  // 8) Persist. `status: 'screening'` and the NULL ledger/fit are the query module's
  //    job, not this route's — it cannot be told otherwise from a request body.
  let job;
  try {
    const { createJob } = await import('@/lib/db/queries/jobs');
    job = await createJob(userId, company, role, jdRaw, validated.value);
  } catch (err) {
    // name + message ONLY — a failing insert carries the whole JD in its parameters.
    console.error('[jobs] job write failed', {
      userId,
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
    return NextResponse.json({ error: 'job_write_failed' }, { status: 500 });
  }

  // 9) Usage on SUCCESS only, once per user-facing operation, INCLUDING the repair
  //    call's tokens (they were really spent). `op` is 'read', not 'fit' — see the
  //    header's two-vocabularies note. THIS ROW is what actually consumes the `fit`
  //    quota (FND-06 counts rows; step 4 only checked).
  //
  //    KNOWN GAP, deliberately not fixed here (docs/plans/FIT-01.md §5 Q3, inherited
  //    verbatim from LIB-01's identical gap): a paid call that completes but fails
  //    JSON/Zod repair costs real money and writes no usage_events row, so the
  //    breaker under-counts it and the quota is not consumed. FND-10 supports
  //    `status: 'failure'` for exactly this, but recording failures WOULD consume
  //    quota (FND-06 counts rows regardless of status) — a product/cost decision for
  //    Horace, and both routes should change together or not at all. The failure
  //    paths above at least console.error so the spend is visible in logs.
  //
  //    Wrapped in try/catch, unlike app/api/parse/route.ts: the job row is ALREADY
  //    committed at this point, so a failure to record usage must not turn a
  //    successful creation into a 500 the client would (reasonably) retry — that
  //    would create a duplicate job and spend a second READ call. recordUsage itself
  //    swallows DB errors (FND-10); this catches a failure of the lazy IMPORT, which
  //    reaches `@/db/index` and can throw on a misconfigured environment.
  try {
    const { recordUsage } = await import('@/lib/usage/record');
    await recordUsage({
      userId,
      op: 'read',
      tokensIn: first.tokensIn + (repair?.tokensIn ?? 0),
      tokensOut: first.tokensOut + (repair?.tokensOut ?? 0),
      searches: 0,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    console.error('[jobs] usage recording failed after a committed job write', {
      userId,
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
  }

  // 10) `no-store`: the body carries the user's pasted JD, and a shared cache holding
  //     it would be a cross-user leak.
  return NextResponse.json(job, { status: 201, headers: NO_STORE });
}
