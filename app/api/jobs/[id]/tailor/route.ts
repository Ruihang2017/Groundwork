import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireUserId, UnauthorizedError } from '@/lib/auth/session';
import { PRIMARY_MODEL } from '@/lib/config/models';
import type { Library } from '@/lib/schemas/entities';
import { Alignment, Edit } from '@/lib/schemas/pipeline';
import {
  buildTailorRepairUserText,
  buildTailorUserText,
  TAILOR_MAX_TOKENS,
  TAILOR_SYSTEM_PROMPT,
} from '@/lib/tailor/prompt';
import { filterByReferentialIntegrity, filterNumberIntegrity, getValidProjectIds } from '@/lib/validation';

// TLR-01 Deliverable 3 — the TAILOR (LLM) route, one request.
//
// PRD ANCHORS
//   §5.1 TAILOR row: "用户决定投 | resumeMd + JdExtract + Ledger → 对齐表 + edits +
//        全文草稿 | … 数字完整性校验（P2）；缺失技能 → gap 提示、不入文 | JSON 修复
//        重试 1 次 → 报错". The trigger is "the user decides to apply", i.e. a Fit
//        already exists — this route REQUIRES job.ledger/job.fit (the inverse of
//        FIT-02's already_fitted guard).
//   §5.3 the full feature spec: keyword alignment table, per-edit rewrites, full
//        draft markdown, and "输出中任何数值必须存在于源简历或库 metrics（服务端
//        regex 交叉校验，违规条目剔除并计数展示）".
//   §2 P1/P2: "在简历定制场景…只重组、换措辞、调强调，永不替用户编造技能和事实——缺
//        什么显示为 gap，不写进简历"; "数字永不虚构。prompt 会漂移，校验不会". The
//        server-side filters below are the actual enforcement; the prompt is
//        best-effort.
//   §5.5 layer 1 (referential integrity on edits) + layer 3 (number integrity on
//        fullDraftMd). FND-07 owns both implementations; this route owns applying
//        them to the right fields (step 10).
//   §8.3 "全部查询以 session userId 约束" — userId comes only from the session, and
//        every DB call is scoped by it inside FIT-01's / LIB-02's query modules.
//
// QUOTA: `tailor` is its OWN bucket (PRD §8.3 "5 tailor"/day), checked exactly once
// in THIS route, before the paid call (ticket Non-goals; docs/plans/TLR-01.md §0.1
// D5). Unlike Fit's charge-once-at-job-creation two-call design, TAILOR is a single
// call — there is no "which call charges it" ambiguity to resolve. FND-06's
// QUOTA_OP_TO_USAGE_OP maps tailor → 'tailor' and its comment obliges each consumer's
// Architect pass to re-confirm the mapping: RE-CONFIRMED for TLR-01 — tailor quota
// bucket ↔ usage op 'tailor' is a 1:1 name match, single call, no ambiguity. So
// checkAndIncrementQuota(userId, 'tailor') and recordUsage({ op: 'tailor' }) count
// against the same bucket.
//
// REPLAY POLICY (docs/plans/TLR-01.md §0.1 D5): there is NO replay guard, and that is
// SAFE here precisely because it is NOT safe in FIT-02. TAILOR charges one `tailor`
// unit on EVERY request before the paid call, so each re-run consumes one of the
// 5/day units — there is no "one charge → unlimited paid calls" abuse vector that
// forced FIT-02's already_fitted guard. upsertTailoredResume OVERWRITES the prior
// draft (one row per job); PRD frames Tailor as a per-job, re-runnable action, not a
// versioned history. If a future change ever moves the quota check off the per-call
// path, this decision must be revisited.
//
// BUILD-TIME SAFETY (the FND-08 bug class): `next build`'s "Collecting page data"
// phase statically imports every app/api/**/route.ts, and db/index.ts THROWS at
// import time when DATABASE_URL is unset (an intentional, tested FND-05 fail-fast).
// `@/lib/config/quota` and `@/lib/usage/record` import `@/db/index` STATICALLY, so
// they — and the three query modules — are imported LAZILY inside the handler.
// Guarded by a test that imports this module with DATABASE_URL blank and no mocks.
// `@/lib/auth/session`, `@/lib/config/models`, `@/lib/tailor/prompt`,
// `@/lib/validation` (its barrel reaches nothing DB-touching), `@/lib/schemas/*`,
// `zod` and `next/server` are safe statically.
//
// WIRE CONTRACT — TLR-02 codes against this, do not improvise:
//
//   POST /api/jobs/{id}/tailor          NO request body is read at all
//
//     200 <the TailoredResume> + `dropped`                    Cache-Control: no-store
//         { jobId, alignment:Alignment, edits:Edit[], fullDraftMd:string,
//           createdAt, updatedAt,
//           dropped: {
//             count: number,                                   // dropped edits +
//                                                              //   stripped numbers
//                                                              //   == usage_events.droppedCount
//             edits:   Array<{ item: Edit; reason: string }>,  // layer-1 discarded edits
//             numbers: Array<{ token: string; reason: string }> // layer-3 stripped tokens
//           } }
//     401 { "error":"Unauthorized" }
//     404 { "error":"not_found" }              unknown id, another user's job, or the
//                                              row vanished mid-request
//     409 { "error":"fit_not_ready" }          job.ledger/job.fit is null — NO paid
//                                              call (Tailor requires a completed Fit)
//     409 { "error":"no_library" }             no library, empty library, OR no source
//                                              résumé — defence in depth
//     422 { "error":"tailor_failed" }          model unusable after one repair (PRD §5.1)
//     429 { "error":"quota_exceeded", "op":"tailor", "resetAt": number }
//     500 { "error":"job_read_failed" | "library_read_failed" | "tailor_write_failed" }
//     503 { "error":"global_breaker_tripped" } tripped OR misconfigured — fail closed
//
// The 200 body is the persisted TailoredResume AT THE TOP LEVEL plus one additive
// `dropped` key, so TLR-02 can `TailoredResume.parse()` it (the extra key strips
// harmlessly) and still render the discarded edits + stripped numbers ("违规条目剔除
// 并计数展示"). `no_library` is 409 here (the job exists → a state conflict, not a
// forbidden creation); TLR-02 must branch on the `error` STRING, not the status code.
// KNOWN LIMITATION (docs/plans/TLR-01.md §5 Q2): `dropped` is NOT persisted (no
// column), so it lives only in this 200 body — after a refresh TLR-02 sees the clean
// persisted draft but not the discard list.
//
// Only POST is exported — Next.js answers every other method with 405 itself.
//
// CSRF: auth.config.ts sets no cookie override, so Auth.js v5 defaults apply
// (httpOnly, sameSite 'lax'); a cross-site POST carries no session cookie and gets a
// 401 before any spend. No extra token — same posture as FIT-01/FIT-02.
//
// LOGGING: never log `jdRaw`, `jd`, the ledger, the library, the source résumé, raw
// model text, request headers (they carry ANTHROPIC_API_KEY), or a raw Drizzle/pg
// error object. Status codes, error name/message, Zod issue PATHS, and counts/lengths
// only. A résumé and a JD are the user's most sensitive data in this app.

export const runtime = 'nodejs';
// Vercel Hobby ceiling. Every timeout below stays under it on purpose.
export const maxDuration = 60;

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
/** Per-call upstream timeout. */
const ANTHROPIC_TIMEOUT_MS = 40_000;
/**
 * The whole handler's budget, below `maxDuration`, so a slow upstream surfaces as OUR
 * 422 rather than a platform 504 with no error contract.
 */
const HANDLER_DEADLINE_MS = 55_000;
/** Below this remaining budget, skip the repair rather than get killed mid-flight. */
const MIN_REPAIR_BUDGET_MS = 8_000;

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * The TAILOR reply contract. Module-local by breakdown-plan.md §3 ("任何模块新增的
 * Zod 类型必须落在自己模块目录下") — do NOT move it into lib/schemas/**. Reuses
 * FND-03's `Alignment` (a bare array carrying the exact four-value status enum) and
 * `Edit` value schemas as-is; do not re-wrap them.
 */
const TailorOutput = z.object({
  alignment: Alignment,
  edits: z.array(Edit),
  fullDraftMd: z.string(),
});
type TailorOutput = z.infer<typeof TailorOutput>;

type Ctx = { params: Promise<{ id: string }> };

type AnthropicCall = {
  text: string;
  tokensIn: number;
  tokensOut: number;
  truncated: boolean;
};

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status });
}

/** PRD §5.1's TAILOR failure policy: "JSON 修复重试 1 次 → 报错". */
function tailorFailed(): NextResponse {
  return json({ error: 'tailor_failed' }, 422);
}

// Postgres rejects U+0000 in `jsonb` AND in `text`, so a NUL byte anywhere in the
// model's parsed output (including `fullDraftMd`, a `text` column) would be an
// unhandled 500 at write time instead of a repairable 422.
const NUL = String.fromCharCode(0);
function hasNulByte(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(NUL);
  if (Array.isArray(value)) return value.some(hasNulByte);
  if (value && typeof value === 'object') return Object.values(value).some(hasNulByte);
  return false;
}

/**
 * One Anthropic Messages call. Returns `null` on any transport/HTTP/timeout failure.
 *
 * Uses the global `fetch` with no injection seam, deliberately (same choice as
 * app/api/jobs/[id]/fit/route.ts): tests stub `globalThis.fetch`, and a `fetchImpl`
 * option would be a live seam in production code existing only for tests.
 */
async function callAnthropic(userText: string, timeoutMs: number): Promise<AnthropicCall | null> {
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
        max_tokens: TAILOR_MAX_TOKENS,
        system: TAILOR_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      console.error('[tailor] anthropic returned', res.status);
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
    console.error('[tailor] anthropic call failed', {
      name: err instanceof Error ? err.name : 'unknown',
    });
    return null;
  }
}

/**
 * Pulls the JSON object out of a model reply: strips an optional code fence, then
 * slices from the first `{` to the last `}`. The prompt forbids fences; this tolerates
 * one anyway rather than burning a paid repair call on a cosmetic violation.
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

type Validation =
  | { ok: true; value: TailorOutput; errorSummary?: undefined }
  | { ok: false; value?: undefined; errorSummary: string };

/**
 * Validates one TAILOR reply. Only HARD (repairable) failures — there is no "soft"
 * category (docs/plans/TLR-01.md §0.1 D4). A reply is HARD-unusable when: it is
 * truncated (`stop_reason: 'max_tokens'`); no JSON object is extractable;
 * `TailorOutput.safeParse` fails; a NUL byte appears anywhere in the parsed object;
 * or `fullDraftMd` is blank after trimming (an empty draft makes TAILOR pointless —
 * the one output worth a repair).
 *
 * There is deliberately NO analog to CROSS's per-field blank check on every
 * edit/alignment string: invalid projectIds and fabricated numbers are handled by the
 * FILTER LAYERS (drop + count), not by repair, and edits are adopted individually by
 * the user (a weak edit is not catastrophic). An over-strict blank check would burn a
 * paid repair call on an otherwise-valid reply.
 */
function validateCall(call: AnthropicCall): Validation {
  if (call.truncated) {
    return { ok: false, errorSummary: 'the reply was cut off before the JSON ended' };
  }
  const parsedJson = extractJsonObject(call.text);
  if (parsedJson === null) {
    return { ok: false, errorSummary: 'the reply was not valid JSON' };
  }
  const parsed = TailorOutput.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      ok: false,
      errorSummary: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }
  if (hasNulByte(parsed.data)) {
    return { ok: false, errorSummary: 'the reply contained a NUL character' };
  }
  if (parsed.data.fullDraftMd.trim() === '') {
    return { ok: false, errorSummary: 'fullDraftMd was empty' };
  }
  return { ok: true, value: parsed.data };
}

export async function POST(_req: Request, ctx: Ctx): Promise<NextResponse> {
  const startedAt = Date.now();

  // 1) Auth FIRST — before any DB access and before any spend. `userId` comes
  //    EXCLUSIVELY from the session (PRD §8.3 trust boundary).
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    if (e instanceof UnauthorizedError) return json({ error: 'Unauthorized' }, 401);
    throw e;
  }

  // 2) The job id, from the path. NO REQUEST BODY IS READ — this route takes no input
  //    beyond the id, so there is no body trust boundary to defend: anything a client
  //    sends is ignored entirely (pinned by a test). Next 15 hands `params` as a
  //    PROMISE; a non-Promise type type-checks in isolation and fails `next build`'s
  //    generated route-type check.
  const { id } = await ctx.params;

  // 3) The job, scoped to its owner. `null` covers BOTH "no such job" and "another
  //    user's job" — indistinguishable by design (PRD §8.3), so both are the same 404
  //    body; a 403 would confirm the id exists. A THROW is row drift (FIT-01's
  //    loud-failure policy), which is a 500, not a 404.
  let job: import('@/lib/db/queries/jobs').PersistedJob | null;
  try {
    const { getJob } = await import('@/lib/db/queries/jobs');
    job = await getJob(userId, id);
  } catch (err) {
    console.error('[tailor] job read failed', {
      userId,
      jobId: id,
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
    return json({ error: 'job_read_failed' }, 500);
  }
  if (!job) return json({ error: 'not_found' }, 404);

  // 4) fit_not_ready guard — the INVERSE of FIT-02's already_fitted guard, and the
  //    cheapest possible rejection (before the library read, the quota check, the
  //    breaker, and any paid call). TAILOR REQUIRES a completed Fit: PRD §5.1's TAILOR
  //    trigger "用户决定投" implies Fit already happened, and its input is
  //    "resumeMd + JdExtract + Ledger". FIT-02 always writes ledger + fit TOGETHER, so
  //    either being null means Fit has not run. Narrows job.ledger/job.fit to non-null.
  if (job.ledger === null || job.fit === null) {
    return json({ error: 'fit_not_ready' }, 409);
  }

  // 5) The library AND the source résumé (both LIB-02, one lazy import, one try/catch).
  //    DEFENCE IN DEPTH (ticket 3(c)): FIT-01 already gated job creation on
  //    hasLibrary and v1 exposes no delete path, so this is unreachable in practice —
  //    kept because a paid TAILOR call with no library/résumé can only fabricate.
  //
  //    A THROW is NOT a 409: getLibrary throws on stored-jsonb drift (LIB-02's
  //    loud-failure policy), and reporting that as no_library would tell a user who
  //    HAS a library to go import another one — a wrong CTA on top of a real bug.
  //    getResume deliberately does not Zod-parse (scalar columns) so it does not throw
  //    on drift; a DB error from either lands here as library_read_failed.
  let library: Library;
  let sourceMd: string;
  try {
    const { getLibrary, getResume } = await import('@/lib/db/queries/library');
    const lib = await getLibrary(userId);
    if (!lib || lib.projects.length === 0) return json({ error: 'no_library' }, 409);
    const resume = await getResume(userId);
    if (!resume) return json({ error: 'no_library' }, 409);
    library = lib;
    sourceMd = resume.sourceMd;
  } catch (err) {
    console.error('[tailor] library/resume read failed', {
      userId,
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
    return json({ error: 'library_read_failed' }, 500);
  }

  // 6) Quota — THE ONE AND ONLY quota check, before the paid call. `tailor` is its own
  //    bucket (see the header). RE-CONFIRMED: FND-06's QUOTA_OP_TO_USAGE_OP[tailor]
  //    === 'tailor'. The lazy import sits INSIDE the try because `@/lib/config/quota`
  //    statically imports `@/db/index` and can throw at import time. A THROW (misconfig
  //    or DB error) FAILS CLOSED to the same 503 as the breaker — the client cannot act
  //    differently on the two, and the operator sees the real reason in the log.
  //    checkGlobalBreaker is captured here and reused in step 7 (one import).
  let checkGlobalBreaker: () => Promise<{ tripped: boolean; spentTodayUsd: number; limitUsd: number }>;
  let quota: { allowed: boolean; remaining: number; resetAt: number };
  try {
    const quotaMod = await import('@/lib/config/quota');
    checkGlobalBreaker = quotaMod.checkGlobalBreaker;
    quota = await quotaMod.checkAndIncrementQuota(userId, 'tailor');
  } catch (err) {
    console.error('[tailor] quota check failed; failing closed', {
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
    return json({ error: 'global_breaker_tripped' }, 503);
  }
  if (!quota.allowed) {
    return json({ error: 'quota_exceeded', op: 'tailor', resetAt: quota.resetAt }, 429);
  }

  // 7) The global spend breaker (PRD §8.3 "全局日花费熔断阈值"), re-checked immediately
  //    before the paid call. Order after quota per Deliverable 3(d)→(e). A THROW returns
  //    the SAME 503 (fail CLOSED).
  try {
    const breaker = await checkGlobalBreaker();
    if (breaker.tripped) return json({ error: 'global_breaker_tripped' }, 503);
  } catch (err) {
    console.error('[tailor] global breaker check failed; failing closed', {
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
    return json({ error: 'global_breaker_tripped' }, 503);
  }

  // 8) The paid call. NO degenerate short-circuit (D6) — TAILOR's core output (a
  //    readability-improved, keyword-aligned draft) is meaningful even for a thin JD,
  //    and quota was already charged. A transport/HTTP/timeout failure on the FIRST
  //    call is a 422 with NO repair (a 429/500/timeout is not a JSON problem).
  const first = await callAnthropic(
    buildTailorUserText(job.jd, job.ledger, library, sourceMd),
    ANTHROPIC_TIMEOUT_MS,
  );
  if (!first) return tailorFailed();

  // 9) EXACTLY ONE repair turn (PRD §5.1 "JSON 修复重试 1 次 → 报错"). Decision table:
  //      reply1 ok                                        → use reply 1
  //      reply1 HARD + repair ok                          → use the repair reply
  //      reply1 HARD + repair HARD / transport-null / skipped → 422 tailor_failed
  //    Reasons and lengths are logged, never the reply text. Both calls' tokens are
  //    summed for recordUsage regardless of which reply is used (the money was spent
  //    either way).
  let repair: AnthropicCall | null = null;
  const validated = validateCall(first);
  let chosen: TailorOutput | null = validated.ok ? validated.value : null;

  if (!validated.ok) {
    // Deadline-aware: below MIN_REPAIR_BUDGET_MS remaining, skip the repair rather than
    // be killed mid-flight and lose our error contract to a platform 504.
    const budgetMs = Math.min(ANTHROPIC_TIMEOUT_MS, HANDLER_DEADLINE_MS - (Date.now() - startedAt));
    console.error('[tailor] first TAILOR reply unusable', {
      stage: 'repair',
      reason: validated.errorSummary.slice(0, 200),
      outputLength: first.text.length,
      budgetMs,
      attempting: budgetMs >= MIN_REPAIR_BUDGET_MS,
    });

    if (budgetMs >= MIN_REPAIR_BUDGET_MS) {
      repair = await callAnthropic(
        buildTailorRepairUserText(first.text, validated.errorSummary),
        budgetMs,
      );
    }

    if (repair) {
      const repaired = validateCall(repair);
      chosen = repaired.ok ? repaired.value : null;
      if (!repaired.ok) {
        console.error('[tailor] TAILOR repair reply also unusable', {
          stage: 'repair',
          reason: repaired.errorSummary.slice(0, 200),
          outputLength: repair.text.length,
        });
      }
    }
  }

  if (chosen === null) return tailorFailed();
  const raw = chosen;

  const tokensIn = first.tokensIn + (repair?.tokensIn ?? 0);
  const tokensOut = first.tokensOut + (repair?.tokensOut ?? 0);

  // 10) The two validation layers this ticket owns, on INDEPENDENT fields (so, unlike
  //     FIT-02, there is no load-bearing order between them):
  //     - Layer 1 (referential integrity) on `edits`: an Edit whose projectId is not in
  //       the library is dropped + counted (PRD §5.5 layer 1). `Edit` structurally
  //       satisfies `{ projectId: string }`.
  //     - Layer 3 (number integrity) on `fullDraftMd`: a numeric token that is not in
  //       the real persisted source résumé OR a project's metrics is stripped + counted
  //       (PRD §5.5 layer 3 — P2's actual enforcement, "prompt 会漂移，校验不会").
  //     `alignment` passes through UNCHANGED: it carries no projectId (layer 1 N/A) and
  //     it is keyword analysis, not résumé content shipped to a recruiter (layer 3 is
  //     scoped to fullDraftMd per Deliverable 3(h); docs/plans/TLR-01.md §5 Q3).
  const { result: keptEdits, dropped: droppedEdits } = filterByReferentialIntegrity(
    raw.edits,
    getValidProjectIds(library),
  );
  const { result: cleanDraftMd, dropped: droppedNumbers } = filterNumberIntegrity(raw.fullDraftMd, {
    resumeMd: sourceMd,
    libraryMetrics: library.projects.flatMap((p) => p.metrics),
  });
  const droppedCount = droppedEdits.length + droppedNumbers.length;

  // 11) Persist (D5 overwrite-in-place; the load-bearing ownership precondition —
  //     getJob above — is satisfied). A THROW → 500. A vanished parent job races an FK
  //     violation here → a throw → 500; acceptable and rare (§4 R4) — do NOT try to map
  //     it to 404 (this is an insert/update, not a scoped update returning null).
  let tailored: import('@/lib/schemas/persisted').TailoredResume;
  try {
    const { upsertTailoredResume } = await import('@/lib/db/queries/tailored-resumes');
    tailored = await upsertTailoredResume(id, raw.alignment, keptEdits, cleanDraftMd);
  } catch (err) {
    console.error('[tailor] tailored_resumes write failed', {
      userId,
      jobId: id,
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
    return json({ error: 'tailor_write_failed' }, 500);
  }

  // 12) Usage on SUCCESS only, exactly once, op 'tailor' (PRD §8.4's dropped/stage
  //     accounting). THIS row is what actually consumes the `tailor` quota (step 6 only
  //     checked). Wrapped in try/catch because the row is ALREADY committed: a failure
  //     to record usage must not turn a successful Tailor into a 500 the client would
  //     retry (a retry would spend another `tailor` unit). recordUsage swallows DB
  //     errors itself (FND-10); this catches a failure of the lazy IMPORT, which reaches
  //     @/db/index.
  //
  //     KNOWN GAP, carried verbatim from FIT-02 and deliberately NOT fixed here: a paid
  //     call that completes but fails validation costs real money and writes no
  //     usage_events row, so the breaker under-counts it. Do NOT unilaterally start
  //     recording status:'failure' here (both routes change together or not at all).
  try {
    const { recordUsage } = await import('@/lib/usage/record');
    await recordUsage({
      userId,
      op: 'tailor',
      tokensIn,
      tokensOut,
      searches: 0,
      durationMs: Date.now() - startedAt,
      droppedCount,
    });
  } catch (err) {
    console.error('[tailor] usage recording failed after a committed write', {
      userId,
      jobId: id,
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
  }

  // 13) `no-store`: the body carries the user's résumé draft (PII); a shared cache
  //     holding it would be a cross-user leak. The TailoredResume is returned AT THE TOP
  //     LEVEL + the additive `dropped` key (D7).
  return NextResponse.json(
    {
      ...tailored,
      dropped: { count: droppedCount, edits: droppedEdits, numbers: droppedNumbers },
    },
    { status: 200, headers: NO_STORE },
  );
}
