import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireUserId, UnauthorizedError } from '@/lib/auth/session';
import { PRIMARY_MODEL } from '@/lib/config/models';
import {
  buildRehearseRepairUserText,
  buildRehearseUserText,
  REHEARSE_MAX_TOKENS,
  REHEARSE_SYSTEM_PROMPT,
} from '@/lib/rehearse/prompt';
import type { Library } from '@/lib/schemas/entities';
import { Intel, Rehearse } from '@/lib/schemas/pipeline';
import { filterByReferentialIntegrity, getValidProjectIds } from '@/lib/validation';

// PRP-02 Deliverable 3 — the REHEARSE (LLM) route: everything above → Rehearse, one
// referential-integrity pass, one Brief write. The STRICT sibling of PRP-01's RESEARCH.
//
// PRD ANCHORS
//   §5.1 REHEARSE row: "全部上文 → questions[5] + askThem[3] + positioning；每个问题必须
//        绑 projectId 且只因该项目的具体内容才可问；trap = 标准答案之后的第二问；askThem
//        必须是不做研究问不出的问题 | JSON 修复重试 1 次 → 报错" (STRICT, "同上").
//   §5.4 unlock condition: Prep is reachable only when job.status === 'interviewing'.
//   §5.5 layer 1: referential integrity on questions[].projectId (getValidProjectIds).
//   §5.6 Brief.rehearse REQUIRED, Brief.intel nullable.
//   §5.8 输出语言跟随 JD.
//   §8.3 "全部查询以 session userId 约束；全局熔断" — userId comes only from the session.
//   §12  搜索结果污染 — `intel` is the injection vector here (web-sourced AND
//        client-supplied); handled by the prompt's untrusted-content clause + the NUL
//        guard + a fixed Zod shape consumed only as data.
//
// QUOTA: this route charges NONE. The `prep` bucket is charged exactly once, UPSTREAM, at
// PRP-01's RESEARCH call, for the whole two-call Prep operation (06-prep/README.md's
// decision). FND-06's QUOTA_OP_TO_USAGE_OP maps prep → 'research' and its comment obliges
// each consumer to re-confirm the mapping: RE-CONFIRMED for PRP-02 — this route records
// usage op 'rehearse', which is NOT a quota-mapped op, so it cannot double-count against
// the bucket PRP-01 already charged. Do NOT add checkAndIncrementQuota here (a test pins
// its absence). The GLOBAL BREAKER is re-checked below, and that is not redundant: it is a
// point-in-time org-wide spend check, not a per-user allowance.
//
// THE STRICT FAILURE CONTRACT (docs/plans/PRP-02.md §0.1 D4) — the load-bearing contrast
// with PRP-01/RESEARCH. A REHEARSE reply unusable after ONE JSON-repair turn ⇒ HTTP 422
// `rehearse_failed`. It does NOT degrade to a 200/null the way RESEARCH does. PRD §5.1's
// REHEARSE failure policy is "同上" = READ/CROSS's "JSON 修复重试 1 次 → 报错", and
// `Brief.rehearse` is NON-NULLABLE (FND-04) — the schema literally cannot persist a
// "partial" REHEARSE. PRD §2 P3's "degrade, don't block" is scoped to best-effort EXTERNAL
// stages (RESEARCH), NOT to REHEARSE. A transport/HTTP/timeout failure on the paid call is
// likewise 422 (a 429/500/timeout is not a JSON problem a second call fixes). A getJob /
// getLibrary / upsertBrief THROW is a 500 (infra, not a model failure), never 422.
//
// D5 (the persisted-rehearse-may-be-<5 resolution): after referential integrity the
// persisted rehearse can carry FEWER than 5 questions, which is not a valid FND-03
// `Rehearse`. The strict `.length(5)` applies only to the PRE-FILTER model-output parse
// (validateCall). The persistence layer (lib/db/queries/briefs.ts) validates the row
// against a module-local RELAXED shape. See that file's D5 note and plan §5 Q1 / §6 ADR-A.
//
// BUILD-TIME SAFETY (the FND-08 bug class): `next build`'s "Collecting page data" phase
// statically imports every app/api/**/route.ts, and db/index.ts THROWS at import time when
// DATABASE_URL is unset (an intentional, tested FND-05 fail-fast). `@/lib/db/queries/jobs`,
// `@/lib/db/queries/library`, `@/lib/config/quota`, `@/lib/db/queries/briefs` and
// `@/lib/usage/record` all reach `@/db/index`, so they are imported LAZILY inside the
// handler. Guarded by a test that imports this module with DATABASE_URL blank and no mocks.
// `@/lib/auth/session`, `@/lib/config/models`, `@/lib/rehearse/prompt`,
// `@/lib/schemas/pipeline`, `@/lib/validation` (its barrel reaches nothing DB-touching),
// `zod` and `next/server` are safe statically.
//
// WIRE CONTRACT — PRP-03/PRP-04 code against this, do not improvise. Branch on the `error`
// STRING (two distinct 409s share the status code):
//
//   POST /api/jobs/{id}/rehearse        body: { "intel": <Intel> | null }
//                                       (the RESEARCH result from PRP-01, passed through)
//
//     200 <Brief> + `dropped`                              Cache-Control: no-store
//         { jobId, intel: <Intel>|null, rehearse: <Rehearse, 0..5 questions>,
//           createdAt, updatedAt,
//           dropped: { count: number,
//                      questions: Array<{ item: RehearseQuestion; reason: string }> } }
//     400 { "error":"invalid_body" }        body not { intel: Intel|null }, or a NUL in intel
//     401 { "error":"Unauthorized" }
//     403 { "error":"not_interviewing" }    job.status !== 'interviewing' (D3)
//     404 { "error":"not_found" }           unknown id OR another user's job
//     409 { "error":"fit_not_ready" }       job.ledger / job.fit absent (D3)
//     409 { "error":"no_library" }          library absent/empty — defence in depth (D3)
//     422 { "error":"rehearse_failed" }     REHEARSE unusable after one repair (STRICT — §5.1)
//     500 { "error":"job_read_failed" | "library_read_failed" | "brief_write_failed" }
//     503 { "error":"global_breaker_tripped" }   tripped OR misconfigured — fail closed
//
// The 200 body is the persisted `Brief` plus one additive `dropped` envelope: the ticket
// says "return the Brief" (3i), but PRD §5.5 layer 1 MANDATES "dropped 计数随响应返回，前端
// 可查看被弃原始条目（透明性）", and FIT-02 already returns exactly this shape. A deliberate,
// PRD-grounded extension of Deliverable 3i (flagged to the Reviewer). `Brief.parse()` strips
// the extra key harmlessly, so PRP-04 may consume the top-level Brief shape and read
// `dropped` when present. KNOWN LIMITATION (same as FIT-02): `dropped.questions` is NOT
// persisted (no column) → render-once, lost on refresh; after a refresh PRP-04 sees only the
// surviving questions via getBrief.
//
// SINGLE-FLIGHT INSTRUCTION TO PRP-03/PRP-04 (D13 / plan §4 R1): issue AT MOST ONE automatic
// REHEARSE per mount behind a `useRef` single-flight guard, and offer only a MANUAL "try
// again". This route charges NOTHING and OVERWRITES on every call (no `already_rehearsed`
// guard — the ticket specifies overwrite), so an auto-retry loop would be UNBOUNDED paid
// (token-cost) calls per single `prep` unit, bounded only by the org-wide breaker. Same
// posture RESEARCH's auto-runner already documents; the cost asymmetry vs TLR-01 (which
// charges every call) is escalated to Horace (plan §5 Q2), NOT closed here.
//
// Only POST is exported — Next.js answers every other method with 405 by itself.
//
// CSRF: auth.config.ts sets no cookie override, so Auth.js v5 defaults apply (httpOnly,
// sameSite 'lax'); a cross-site POST carries no session cookie and gets a 401 before any
// spend. No extra token — same posture as every peer route.
//
// LOGGING: never log the model's raw text, the returned Brief/intel/rehearse,
// job.jdRaw/job.jd/job.ledger, the library, request headers (they carry ANTHROPIC_API_KEY),
// a raw Drizzle/pg error, or company/role. Status codes, error name/message, Zod issue
// PATHS, projectIds, and counts/lengths only.

export const runtime = 'nodejs';
// Vercel Hobby ceiling. Every timeout below stays under it on purpose.
export const maxDuration = 60;

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
/** Per-call upstream timeout. No web search here, so the shorter FIT-02 budget applies. */
const ANTHROPIC_TIMEOUT_MS = 40_000;
/**
 * The whole handler's budget, below `maxDuration`, so a slow upstream surfaces as OUR 422
 * rather than a platform 504 with no error contract. PRD §5.1's "Prep ≤ 90s" p50 budgets
 * RESEARCH + REHEARSE together, so this single call sits well under it.
 */
const HANDLER_DEADLINE_MS = 55_000;
/** Below this remaining budget, skip the repair rather than get killed mid-flight. */
const MIN_REPAIR_BUDGET_MS = 8_000;

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

// D8: the request body is the ONLY input any Prep route reads, and REHEARSE reads exactly
// one field. `.nullable()` (not `.optional()`) means the `intel` KEY must be present — it
// may be `null` (degraded RESEARCH) but not absent — matching PRP-01's wire contract that
// PRP-04 will send (`{ intel: Intel | null }`).
const BodySchema = z.object({ intel: Intel.nullable() });

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

/**
 * PRD §5.1's REHEARSE failure policy: "JSON 修复重试 1 次 → 报错". The STRICT analogue of
 * FIT-02's `crossFailed()`. DELIBERATELY NOT a degraded 200: PRD §2 P3's "degrade, don't
 * block" is scoped to best-effort external stages (RESEARCH), not to REHEARSE, and
 * `Brief.rehearse` is non-nullable (FND-04) so a partial brief cannot even be persisted.
 */
function rehearseFailed(): NextResponse {
  return json({ error: 'rehearse_failed' }, 422);
}

// Postgres rejects U+0000 in `jsonb`, so a NUL byte anywhere in the model's parsed output
// (written to briefs.rehearse) OR in the client-supplied body.intel (written to
// briefs.intel) would be an unhandled 500 at write time instead of a handled 4xx.
const NUL = String.fromCharCode(0);
function hasNulByte(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(NUL);
  if (Array.isArray(value)) return value.some(hasNulByte);
  if (value && typeof value === 'object') return Object.values(value).some(hasNulByte);
  return false;
}

/**
 * Pulls the JSON object out of a model reply: strips an optional code fence, then slices
 * from the first `{` to the last `}`. The prompt forbids fences; this tolerates one anyway
 * rather than burning a paid repair call on a cosmetic violation. Copied from FIT-02.
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
 * One Anthropic Messages call. Returns `null` on any transport/HTTP/timeout failure.
 *
 * Copied from FIT-02's NO-TOOLS version: REHEARSE never searches, so there is no
 * `tools` key at all and `text` is a simple join of the reply's text blocks (no tool
 * preamble to skip, unlike RESEARCH's `extractFinalText`). Uses the global `fetch` with no
 * injection seam, deliberately (same choice as the peer routes): tests stub `globalThis.fetch`.
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
        max_tokens: REHEARSE_MAX_TOKENS,
        system: REHEARSE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      // Log the upstream status (and a best-effort error type/message) so a persistent
      // upstream failure is diagnosable. NEVER log the request body (it carries the prompt).
      let upstreamType: string | undefined;
      let upstreamMessage: string | undefined;
      try {
        const errBody = await res.json();
        const e = errBody?.error;
        if (typeof e?.type === 'string') upstreamType = e.type;
        if (typeof e?.message === 'string') upstreamMessage = String(e.message).slice(0, 200);
      } catch {
        // non-JSON error body — the status alone is still logged
      }
      console.error('[rehearse] anthropic returned non-2xx', {
        status: res.status,
        upstreamType,
        upstreamMessage,
      });
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
    console.error('[rehearse] anthropic call failed', {
      name: err instanceof Error ? err.name : 'unknown',
    });
    return null;
  }
}

type Validation = { ok: true; value: Rehearse } | { ok: false; errorSummary: string };

/**
 * Validates one REHEARSE reply against the D6 hard-failure classes, in order. There is NO
 * "soft" class — REHEARSE is STRICT (unlike CROSS, whose double-cover overlap is soft).
 *
 * 1. truncation (`stop_reason: 'max_tokens'`) — truncated JSON is never a short answer;
 * 2. no extractable JSON object;
 * 3. `Rehearse.safeParse` failure — this is where the count rules are enforced:
 *    `questions.length !== 5`, `askThem.length !== 3` (both `.length()` in FND-03), and any
 *    empty `trap` (FND-03 gives `trap` a `.min(1)`). Over-length arrays are REPAIRED, never
 *    silently sliced — the counts are PRD §5.1/§5.4 rules, not our formatting preference;
 * 4. a NUL byte anywhere in the parsed object (protects the briefs.rehearse jsonb write);
 * 5. a blank required string NOT covered by Zod: any `questions[].question`, any
 *    `questions[].projectId`, `positioning`, or any `askThem[]` entry that is ''/whitespace.
 *    FND-03 gives `.min(1)` ONLY to `trap`, so these four accept '' — a blank `question`
 *    renders an empty rehearsal card; a blank `projectId` would be dropped by referential
 *    integrity and is never a real citation.
 */
function validateCall(call: AnthropicCall): Validation {
  if (call.truncated) {
    return { ok: false, errorSummary: 'the reply was cut off before the JSON ended' };
  }
  const parsedJson = extractJsonObject(call.text);
  if (parsedJson === null) {
    return { ok: false, errorSummary: 'the reply was not valid JSON' };
  }
  const parsed = Rehearse.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      ok: false,
      errorSummary: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }
  if (hasNulByte(parsed.data)) {
    return { ok: false, errorSummary: 'the reply contained a NUL character' };
  }
  const blank =
    parsed.data.positioning.trim() === '' ||
    parsed.data.questions.some((q) => q.question.trim() === '' || q.projectId.trim() === '') ||
    parsed.data.askThem.some((a) => a.trim() === '');
  if (blank) {
    return {
      ok: false,
      errorSummary:
        'positioning, every questions[].question and questions[].projectId, and every askThem[] entry must be a non-empty string',
    };
  }
  return { ok: true, value: parsed.data };
}

export async function POST(req: Request, ctx: Ctx): Promise<NextResponse> {
  const startedAt = Date.now();

  // 1) Auth FIRST — before any DB access and before any spend. `userId` comes EXCLUSIVELY
  //    from the session (PRD §8.3 trust boundary).
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    if (e instanceof UnauthorizedError) return json({ error: 'Unauthorized' }, 401);
    throw e;
  }

  // 2) The job id, from the path. Next 15 hands `params` as a PROMISE; a non-Promise type
  //    type-checks in isolation and fails `next build`'s generated route-type check.
  const { id } = await ctx.params;

  // 3) The job, scoped to its owner. `null` covers BOTH "no such job" and "another user's
  //    job" — indistinguishable by design (PRD §8.3), so both are the same 404 body. A
  //    THROW is row drift (FIT-01's loud-failure policy), which is a 500, NOT a 404 and NOT
  //    a 422 (it is not a model failure — D4).
  let job: import('@/lib/db/queries/jobs').PersistedJob | null;
  try {
    const { getJob } = await import('@/lib/db/queries/jobs');
    job = await getJob(userId, id);
  } catch (err) {
    console.error('[rehearse] job read failed', {
      userId,
      jobId: id,
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
    return json({ error: 'job_read_failed' }, 500);
  }
  if (!job) return json({ error: 'not_found' }, 404);

  // 4) The D3 funnel gates, BOTH before any body read and any spend.
  //    (a) PRD §5.4 makes status === 'interviewing' THE unlock condition for Prep. The UI
  //        (PRP-03) is the primary gate; this server check rejects an API client that
  //        skips the UI (PRD §8.3 spirit — same as RESEARCH / FIT-01's no-library gate).
  //        Loosening it for a dogfood "preview" is a product decision for Horace (plan §5
  //        Q6), NOT a silent Builder change.
  if (job.status !== 'interviewing') return json({ error: 'not_interviewing' }, 403);
  //    (b) REHEARSE needs a completed Fit's ledger; without it the operation provably
  //        cannot finish (FIT-01/TLR-01's defensive pattern).
  if (job.ledger === null || job.fit === null) return json({ error: 'fit_not_ready' }, 409);

  // 5) Body (D8). Read `req.json()` inside try/catch; a JSON-parse throw and a Zod failure
  //    collapse to the same 400 `invalid_body`. Then reject a NUL byte in body.intel (a
  //    direct API client could POST a poisoned Intel that would detonate the briefs.intel
  //    jsonb write) — defence in depth, never trust the body.
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      console.error('[rehearse] invalid request body', {
        userId,
        jobId: id,
        issues: err.issues.map((i) => i.path.join('.')),
      });
    }
    return json({ error: 'invalid_body' }, 400);
  }
  if (hasNulByte(body.intel)) return json({ error: 'invalid_body' }, 400);

  // 6) The library. DEFENCE IN DEPTH (a deliberate ADDITION — Deliverable 3 is silent on
  //    it, flagged to the Reviewer): without a library, getValidProjectIds is empty and
  //    referential integrity would drop ALL 5 questions, and the prompt would have no
  //    project ids to cite. REHEARSE is gated behind fit_not_ready and a fit implies a
  //    library existed, so this is practically unreachable — kept anyway, as FIT-02 argues.
  //    A getLibrary THROW is a 500, NOT no_library (telling a user who HAS a library to
  //    import one is a wrong CTA on a real bug — FIT-02's exact reasoning).
  let library: Library | null;
  try {
    const { getLibrary } = await import('@/lib/db/queries/library');
    library = await getLibrary(userId);
  } catch (err) {
    console.error('[rehearse] library read failed', {
      userId,
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
    return json({ error: 'library_read_failed' }, 500);
  }
  if (!library || library.projects.length === 0) {
    return json({ error: 'no_library' }, 409);
  }

  // 7) The global spend breaker (PRD §8.3), re-checked immediately before this route's own
  //    paid call. A THROW returns the SAME 503 (fail CLOSED): the client cannot act
  //    differently on "tripped" vs "misconfigured", and the operator sees the real reason
  //    in the log. The lazy import sits INSIDE the try because `@/lib/config/quota`
  //    statically imports `@/db/index` and can throw at import time.
  //
  //    NO checkAndIncrementQuota HERE — the `prep` unit was charged at PRP-01/RESEARCH (see
  //    the header's QUOTA note). A test pins its absence.
  try {
    const { checkGlobalBreaker } = await import('@/lib/config/quota');
    const breaker = await checkGlobalBreaker();
    if (breaker.tripped) return json({ error: 'global_breaker_tripped' }, 503);
  } catch (err) {
    console.error('[rehearse] global breaker check failed; failing closed', {
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
    return json({ error: 'global_breaker_tripped' }, 503);
  }

  // 8) THE PAID CALL + one repair (D4/D6/D7), deadline-aware. `job.ledger`/`job.fit` are
  //    guaranteed non-null here by step 4. A transport/HTTP/timeout failure on the FIRST
  //    call is a 422 with NO repair (a 429/500/timeout is not a JSON problem). DELIBERATE
  //    422 — NOT PRP-01's degraded 200: REHEARSE is STRICT (see the header's failure contract).
  const first = await callAnthropic(
    buildRehearseUserText(job.jd, job.ledger, library, body.intel),
    ANTHROPIC_TIMEOUT_MS,
  );
  if (!first) return rehearseFailed();

  let repair: AnthropicCall | null = null;
  const firstValidation = validateCall(first);
  let chosen: Rehearse | null = firstValidation.ok ? firstValidation.value : null;

  if (!firstValidation.ok) {
    // Deadline-aware: below MIN_REPAIR_BUDGET_MS remaining, skip the repair rather than be
    // killed mid-flight and lose our error contract to a platform 504.
    const budgetMs = Math.min(ANTHROPIC_TIMEOUT_MS, HANDLER_DEADLINE_MS - (Date.now() - startedAt));
    console.error('[rehearse] first reply unusable', {
      userId,
      jobId: id,
      reason: firstValidation.errorSummary.slice(0, 200),
      outputLength: first.text.length,
      budgetMs,
      attempting: budgetMs >= MIN_REPAIR_BUDGET_MS,
    });
    if (budgetMs >= MIN_REPAIR_BUDGET_MS) {
      // The repair re-sends STRUCTURE only — no jd/ledger/library/intel (D7).
      repair = await callAnthropic(
        buildRehearseRepairUserText(first.text, firstValidation.errorSummary),
        budgetMs,
      );
      if (repair) {
        const repairValidation = validateCall(repair);
        if (repairValidation.ok) {
          chosen = repairValidation.value;
        } else {
          console.error('[rehearse] repair reply also unusable', {
            userId,
            jobId: id,
            reason: repairValidation.errorSummary.slice(0, 200),
            outputLength: repair.text.length,
          });
        }
      }
    }
  }

  if (chosen === null) return rehearseFailed();

  // Both calls' tokens are summed regardless of WHICH reply is used — the money was spent
  // either way.
  const tokensIn = first.tokensIn + (repair?.tokensIn ?? 0);
  const tokensOut = first.tokensOut + (repair?.tokensOut ?? 0);

  // 9) Referential integrity (PRD §5.5 layer 1 — the only layer REHEARSE applies, D12).
  //    Questions citing a projectId not in the library are dropped and counted; the
  //    survivors may number < 5 (D5 — that is why the persistence layer relaxes the length).
  const { result: keptQuestions, dropped } = filterByReferentialIntegrity(
    chosen.questions,
    getValidProjectIds(library),
  );
  const filteredRehearse = { ...chosen, questions: keptQuestions };

  // 10) Persist the complete Brief in ONE write. `upsertBrief` takes NO userId — ownership
  //     was proven in step 3's getJob (the sole ownership gate for this write, plan §4 S2).
  //     A THROW ⇒ 500 brief_write_failed (infra, never 422). `filteredRehearse` is passed as
  //     FND-03's `Rehearse`; the < 5-questions case is accepted by briefs.ts's relaxed shape.
  let brief: Awaited<ReturnType<typeof import('@/lib/db/queries/briefs').upsertBrief>>;
  try {
    const { upsertBrief } = await import('@/lib/db/queries/briefs');
    brief = await upsertBrief(id, body.intel, filteredRehearse as Rehearse);
  } catch (err) {
    console.error('[rehearse] brief write failed', {
      userId,
      jobId: id,
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
    return json({ error: 'brief_write_failed' }, 500);
  }

  // 11) Usage on SUCCESS only, exactly once, with op 'rehearse' (D11). Wrapped in try/catch
  //     for the same reason the peer routes wrap theirs: the Brief is ALREADY committed, so
  //     a failure to record usage must not turn a good result into a 500 the client retries
  //     (buying another paid call). recordUsage itself swallows DB errors (FND-10); this
  //     catches a failure of the lazy IMPORT, which reaches `@/db/index`.
  //
  //     KNOWN GAP, carried verbatim from FIT-02/PRP-01 and deliberately NOT fixed here
  //     (plan §5 Q3 / §4 R5): a 422 path records NOTHING, so the breaker under-counts its
  //     (token-only) spend. FND-10 supports status:'failure', but recording it WOULD consume
  //     quota (FND-06 counts rows regardless of status) — a repo-wide product/cost decision
  //     for Horace. Do NOT unilaterally start recording failures here; all stage routes
  //     change together or not at all.
  try {
    const { recordUsage } = await import('@/lib/usage/record');
    await recordUsage({
      userId,
      op: 'rehearse',
      tokensIn,
      tokensOut,
      searches: 0, // REHEARSE never searches
      durationMs: Date.now() - startedAt,
      droppedCount: dropped.length,
    });
  } catch (err) {
    console.error('[rehearse] usage recording failed after a committed brief write', {
      userId,
      jobId: id,
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
  }

  // 12) `no-store`: the body carries the user's brief (their intel + project-anchored
  //     questions); a shared cache holding it would be a cross-user leak (plan §4 S4). The
  //     additive `dropped` envelope satisfies PRD §5.5 layer 1's transparency mandate (D2).
  return NextResponse.json(
    { ...brief, dropped: { count: dropped.length, questions: dropped } },
    { status: 200, headers: NO_STORE },
  );
}
