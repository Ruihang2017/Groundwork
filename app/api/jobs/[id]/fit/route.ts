import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireUserId, UnauthorizedError } from '@/lib/auth/session';
import { PRIMARY_MODEL } from '@/lib/config/models';
import {
  buildCrossRepairUserText,
  buildCrossUserText,
  CROSS_MAX_TOKENS,
  CROSS_SYSTEM_PROMPT,
} from '@/lib/cross/prompt';
import { computeFitReport } from '@/lib/scoring/score';
import type { Library } from '@/lib/schemas/entities';
import { Binding, Gap, HardRequirementCheck, type FitReport } from '@/lib/schemas/pipeline';
import {
  ensureRequirementCoverage,
  filterByReferentialIntegrity,
  getValidProjectIds,
} from '@/lib/validation';

// FIT-02 Deliverable 3 — the CROSS (LLM) + SCORE (pure code) route, one request.
//
// PRD ANCHORS
//   §5.1 CROSS row: "JdExtract × Library → Ledger；每条 requirement 恰好落入
//        bindings ∪ gaps 之一；binding 必须引用库条目中的具体技术细节；无量化 PoC
//        遇 scale/production 类要求封顶 partial；gap 必须给 probe + play |
//        JSON 修复重试 1 次 → 报错".
//   §5.1 SCORE row: "纯代码；模型不输出分数" — lib/scoring/score.ts, called below.
//   §5.2 The Fit Report spec (hard requirements, four sub-scores, tier, advice,
//        top gaps) — produced entirely by computeFitReport, never by the model.
//   §5.5 layers 1 + 2: referential integrity, then requirement coverage. FND-07 owns
//        both implementations; this route owns the ORDER (see step 10 — load-bearing).
//   §8.3 "全部查询以 session userId 约束" — userId comes only from the session, and
//        every DB call is scoped by it inside FIT-01's / LIB-02's query modules.
//
// QUOTA: this route charges NONE. The `fit` bucket is charged exactly once, upstream,
// at FIT-01's job creation (04-fit/README.md's decision), for the whole two-call Fit
// operation. FND-06's QUOTA_OP_TO_USAGE_OP maps fit → 'read' and its comment obliges
// each consumer to re-confirm the mapping: RE-CONFIRMED for FIT-02 — this route
// records usage op 'cross', which is NOT a quota-mapped op, so it cannot double-count
// against the bucket FIT-01 already charged. Do NOT add checkAndIncrementQuota here
// (a test pins its absence). The GLOBAL BREAKER is re-checked below, and that is not
// redundant: it is a point-in-time org-wide spend check, not a per-user allowance.
//
// REPLAY GUARD (docs/plans/FIT-02.md §0.1 D7, and it is load-bearing — §4 R1): because
// quota is charged once at job creation, an unguarded replay would buy UNLIMITED paid
// CROSS calls per charge, spending real money until the org-wide breaker trips — a cost
// event and a denial of service against every other user at once. So `job.fit !== null`
// ⇒ 409 already_fitted, before any paid call. v1 has no re-run: re-running Fit means
// creating a new job, which costs a fresh `fit` unit. Do not weaken this for
// convenience. KNOWN, ACCEPTED: the guard's check-then-act window is still open (two
// concurrent POSTs can both read fit === null and both pay); bounded to ~1 extra call
// per job and structurally identical to FND-06's accepted quota race. Closing it needs
// a claim column or an advisory lock — FND-05 file-scope and a deliberate hardening
// decision for Horace, NOT a silent addition here (§4 R2).
//
// BUILD-TIME SAFETY (the FND-08 bug class): `next build`'s "Collecting page data" phase
// statically imports every app/api/**/route.ts, and db/index.ts THROWS at import time
// when DATABASE_URL is unset (an intentional, tested FND-05 fail-fast). `@/lib/config/
// quota` and `@/lib/usage/record` import `@/db/index` STATICALLY, so they — and both
// query modules — are imported LAZILY inside the handler. Guarded by a test that
// imports this module with DATABASE_URL blank and no mocks. `@/lib/auth/session`,
// `@/lib/config/models`, `@/lib/cross/prompt`, `@/lib/scoring/score`, `@/lib/validation`
// (its barrel reaches nothing DB-touching), `@/lib/schemas/*`, `zod` and `next/server`
// are safe statically.
//
// WIRE CONTRACT — FIT-03 codes against this, do not improvise:
//
//   POST /api/jobs/{id}/fit          NO request body is read at all
//
//     200 <the completed job> + `dropped` + `anomalies`      Cache-Control: no-store
//         { id, userId, company, role, status, jdRaw, jd, ledger:Ledger, fit:FitReport,
//           createdAt, updatedAt,
//           dropped: {
//             count: number,                 // layer-1 dropped bindings + layer-2
//                                            //   injected gaps == usage_events.droppedCount
//             bindings: Array<{ item: Binding; reason: string }>,  // layer 1's raw discards
//             uncoveredRequirementIds: string[]                    // layer 2's injections
//           },
//           anomalies: {
//             doubleCoveredRequirementIds: string[],  // in bindings AND gaps; scored as bound
//             unknownRequirementIds: string[]         // referenced but absent from jd
//           } }
//     401 { "error":"Unauthorized" }
//     404 { "error":"not_found" }            unknown id, another user's job, or the row
//                                            vanished mid-request
//     409 { "error":"already_fitted" }       job.fit is already populated — NO paid call
//     409 { "error":"no_library" }           defence in depth; see step 5
//     422 { "error":"cross_failed" }         CROSS unusable after one repair (PRD §5.1)
//     500 { "error":"job_read_failed" | "library_read_failed" | "score_failed"
//           | "job_write_failed" }
//     503 { "error":"global_breaker_tripped" }   tripped OR misconfigured — fail closed
//
// The 200 body is the completed job AT THE TOP LEVEL (same shape as FIT-01's 201 body)
// plus two additive keys, so FIT-03 can treat both routes' 2xx bodies identically and
// `Job.parse()` strips the extras harmlessly. PRD §5.5 layer 1 requires the dropped
// count to travel with the response ("dropped 计数随响应返回，前端可查看被弃原始条目").
// KNOWN LIMITATION (plan §5 Q2, not solvable in this ticket's file-scope): dropped items
// are NOT persisted — `jobs` has no column for them — so after a refresh FIT-03 can only
// render the injected 'uncovered — rerun' gaps, which do live in `ledger`.
//
// `no_library` is 409 here where FIT-01 returns 403, ON PURPOSE: the job already exists,
// so this is a state conflict rather than a forbidden creation. FIT-03 must branch on
// the `error` STRING, not on the status code.
//
// Only POST is exported — Next.js answers every other method with 405 by itself.
//
// CSRF: auth.config.ts sets no cookie override, so Auth.js v5 defaults apply (httpOnly,
// sameSite 'lax'); a cross-site POST carries no session cookie and gets a 401 before any
// spend. No extra token — same posture as FIT-01/LIB-01/LIB-02.
//
// LOGGING: never log `jdRaw`, `jd`, the library, raw model text, request headers (they
// carry ANTHROPIC_API_KEY), or a raw Drizzle/pg error object. Status codes, error
// name/message, Zod issue PATHS, requirement IDs, and counts/lengths only.

export const runtime = 'nodejs';
// Vercel Hobby ceiling. Every timeout below stays under it on purpose.
export const maxDuration = 60;

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
/** Per-call upstream timeout. */
const ANTHROPIC_TIMEOUT_MS = 40_000;
/**
 * The whole handler's budget, below `maxDuration`, so a slow upstream surfaces as OUR
 * 422 rather than a platform 504 with no error contract. FIT-01 uses a fixed 45s + 45s
 * which can exceed maxDuration on its repair path — reported, not fixed here (plan
 * §5 Q5; that file is out of this ticket's scope).
 */
const HANDLER_DEADLINE_MS = 55_000;
/** Below this remaining budget, skip the repair rather than get killed mid-flight. */
const MIN_REPAIR_BUDGET_MS = 8_000;

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * The CROSS reply contract. Module-local by breakdown-plan.md §3 ("任何模块新增的 Zod
 * 类型必须落在自己模块目录下") — do NOT move it into lib/schemas/**. `.max(8)` is a
 * sanity bound on a field the prompt caps at ~4 kinds; it is not a semantic rule.
 */
const CrossOutput = z.object({
  bindings: z.array(Binding),
  gaps: z.array(Gap),
  hardRequirements: z.array(HardRequirementCheck).max(8),
});
type CrossOutput = z.infer<typeof CrossOutput>;

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

/** PRD §5.1's CROSS failure policy: "JSON 修复重试 1 次 → 报错". */
function crossFailed(): NextResponse {
  return json({ error: 'cross_failed' }, 422);
}

// Postgres rejects U+0000 in `jsonb`, so a NUL byte anywhere in the model's parsed
// output would be an unhandled 500 at write time instead of a repairable 422.
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
 * app/api/jobs/route.ts and app/api/parse/route.ts): tests stub `globalThis.fetch`, and
 * a `fetchImpl` option on a request handler would be a live seam in production code
 * existing only for tests.
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
        max_tokens: CROSS_MAX_TOKENS,
        system: CROSS_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      console.error('[fit] anthropic returned', res.status);
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
    console.error('[fit] anthropic call failed', {
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
  | { ok: true; value: CrossOutput }
  | { ok: false; kind: 'hard'; errorSummary: string; value?: undefined }
  | { ok: false; kind: 'soft'; errorSummary: string; value: CrossOutput };

/**
 * Validates one CROSS reply.
 *
 * HARD = unusable, no `value`: truncation, non-JSON, Zod failure, a NUL byte, or an
 * empty required string. SOFT = usable but rule-violating, `value` present: a
 * requirementId appearing in BOTH `bindings` and `gaps` (D11). A soft failure triggers
 * the one repair turn but never a 422 on its own — repairing maximises PRD §6 Q1's
 * "覆盖恰好一次" pass rate, while refusing to 422 means a cosmetic overlap never costs
 * the user their already-paid Fit. Uncovered requirements are deliberately not a
 * failure at ALL: PRD §5.5 layer 2 prescribes auto-injection for exactly that case.
 */
function validateCall(call: AnthropicCall): Validation {
  if (call.truncated) {
    return { ok: false, kind: 'hard', errorSummary: 'the reply was cut off before the JSON ended' };
  }
  const parsedJson = extractJsonObject(call.text);
  if (parsedJson === null) {
    return { ok: false, kind: 'hard', errorSummary: 'the reply was not valid JSON' };
  }
  const parsed = CrossOutput.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      ok: false,
      kind: 'hard',
      errorSummary: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }
  if (hasNulByte(parsed.data)) {
    return { ok: false, kind: 'hard', errorSummary: 'the reply contained a NUL character' };
  }

  // Non-empty required strings. FND-03's schema allows '' everywhere; an empty
  // `evidence`/`probe`/`play` is a failed binding or a filler gap, and PRD §5.1 requires
  // both halves of a gap. NOTE: this check is deliberately NEVER re-run on the FINAL
  // ledger — FND-07's layer-2 injected gaps carry `play: ''` by design, and
  // re-validating would reject the repo's own repair mechanism.
  const blank =
    parsed.data.bindings.some((b) => b.evidence.trim() === '') ||
    parsed.data.gaps.some((g) => g.probe.trim() === '' || g.play.trim() === '') ||
    parsed.data.hardRequirements.some((h) => h.label.trim() === '');
  if (blank) {
    return {
      ok: false,
      kind: 'hard',
      errorSummary:
        'every binding.evidence, gap.probe, gap.play and hardRequirement.label must be a non-empty string',
    };
  }

  const bindingIds = new Set(parsed.data.bindings.map((b) => b.requirementId));
  const doubled = parsed.data.gaps
    .map((g) => g.requirementId)
    .filter((id) => bindingIds.has(id));
  if (doubled.length > 0) {
    return {
      ok: false,
      kind: 'soft',
      errorSummary: `these requirement ids appear in BOTH bindings and gaps and must appear exactly once: ${[...new Set(doubled)].join(', ')}`,
      value: parsed.data,
    };
  }

  return { ok: true, value: parsed.data };
}

/** Ids referenced by an item but absent from the JD — counted and reported, never filtered. */
function unknownIds(items: Array<{ requirementId: string }>, known: Set<string>): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (!known.has(item.requirementId) && !out.includes(item.requirementId)) {
      out.push(item.requirementId);
    }
  }
  return out;
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
  //    body; a 403 would confirm that an id exists. A THROW is row drift (FIT-01's
  //    loud-failure policy), which is a 500, not a 404.
  let job: import('@/lib/db/queries/jobs').PersistedJob | null;
  try {
    const { getJob } = await import('@/lib/db/queries/jobs');
    job = await getJob(userId, id);
  } catch (err) {
    console.error('[fit] job read failed', {
      userId,
      jobId: id,
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
    return json({ error: 'job_read_failed' }, 500);
  }
  if (!job) return json({ error: 'not_found' }, 404);

  // 4) D7's replay guard — the cheapest possible rejection, before the library read and
  //    before the breaker. Zero paid calls, zero writes. See the header for why this is
  //    load-bearing rather than a nicety.
  if (job.fit !== null) return json({ error: 'already_fitted' }, 409);

  // 5) The library. DEFENCE IN DEPTH, documented as such: FIT-01 already gated job
  //    creation on having a library and 03-library exposes no delete endpoint in v1, so
  //    this is genuinely unreachable in practice — kept anyway because CROSS without a
  //    library would be a paid call that can only produce gaps.
  //
  //    A THROW is NOT a 409: getLibrary throws when the stored jsonb has drifted
  //    (LIB-02's loud-failure policy), and reporting that as `no_library` would tell a
  //    user who HAS a library to go import another one — a wrong CTA on top of a real bug.
  let library: Library | null;
  try {
    const { getLibrary } = await import('@/lib/db/queries/library');
    library = await getLibrary(userId);
  } catch (err) {
    console.error('[fit] library read failed', {
      userId,
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
    return json({ error: 'library_read_failed' }, 500);
  }
  if (!library || library.projects.length === 0) {
    return json({ error: 'no_library' }, 409);
  }

  // 6) The global spend breaker (PRD §8.3 "全局日花费熔断阈值"), re-checked immediately
  //    before THIS route's own paid call — not redundant with FIT-01's check seconds
  //    earlier, because the breaker is a point-in-time org-wide state, not a per-user
  //    allowance. A THROW returns the SAME 503 (fail CLOSED): the client cannot act
  //    differently on "tripped" vs "misconfigured", and the operator sees the real
  //    reason in the log. The lazy import sits INSIDE the try because
  //    `@/lib/config/quota` statically imports `@/db/index` and can throw at import time.
  //
  //    NO checkAndIncrementQuota HERE — see the header's quota note. A test pins it.
  try {
    const { checkGlobalBreaker } = await import('@/lib/config/quota');
    const breaker = await checkGlobalBreaker();
    if (breaker.tripped) return json({ error: 'global_breaker_tripped' }, 503);
  } catch (err) {
    console.error('[fit] global breaker check failed; failing closed', {
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
    return json({ error: 'global_breaker_tripped' }, 503);
  }

  let raw: CrossOutput;
  let tokensIn = 0;
  let tokensOut = 0;

  if (job.jd.requirements.length === 0) {
    // 7) DEGENERATE SHORT-CIRCUIT: a CROSS call with nothing to cover can only cost
    //    money. A zero-requirement JdExtract is schema-legal, so this path is real. The
    //    resulting compositeScore 0 / 'Long shot' report is honest but reads as a
    //    verdict on the candidate rather than on the extraction — reported, not fixed
    //    here; if real runs produce it, the fix belongs in READ (plan §5 Q7).
    raw = { bindings: [], gaps: [], hardRequirements: [] };
  } else {
    // 8) The paid call. A transport/HTTP/timeout failure on the FIRST call is a 422
    //    with NO repair: a 429/500/timeout is not a JSON problem, and a second paid
    //    call cannot help.
    const first = await callAnthropic(buildCrossUserText(job.jd, library), ANTHROPIC_TIMEOUT_MS);
    if (!first) return crossFailed();

    let repair: AnthropicCall | null = null;
    const validated = validateCall(first);
    let chosen: CrossOutput | null = validated.ok ? validated.value : null;

    // 9) EXACTLY ONE repair turn (PRD §5.1 "JSON 修复重试 1 次 → 报错"). Decision table:
    //      reply1 ok                                        → use reply 1
    //      reply1 soft + repair ok|soft                     → use the repair reply
    //      reply1 soft + repair hard|transport-null|skipped → use reply 1 (it is usable)
    //      reply1 hard + repair ok|soft                     → use the repair reply
    //      reply1 hard + repair hard|transport-null|skipped → 422 cross_failed
    //    Reasons and lengths are logged, never the reply text.
    if (!validated.ok) {
      // Deadline-aware: below MIN_REPAIR_BUDGET_MS remaining, skip the repair rather
      // than be killed mid-flight and lose our error contract to a platform 504.
      const budgetMs = Math.min(
        ANTHROPIC_TIMEOUT_MS,
        HANDLER_DEADLINE_MS - (Date.now() - startedAt),
      );
      console.error('[fit] first CROSS reply unusable', {
        stage: 'repair',
        kind: validated.kind,
        reason: validated.errorSummary.slice(0, 200),
        outputLength: first.text.length,
        budgetMs,
        attempting: budgetMs >= MIN_REPAIR_BUDGET_MS,
      });

      if (budgetMs >= MIN_REPAIR_BUDGET_MS) {
        repair = await callAnthropic(
          buildCrossRepairUserText(first.text, validated.errorSummary),
          budgetMs,
        );
      }

      if (repair) {
        const repaired = validateCall(repair);
        // `value` is present for both `ok` and `soft`; absent only for `hard`.
        chosen = repaired.value ?? validated.value ?? null;
        if (!repaired.ok) {
          console.error('[fit] CROSS repair reply also unusable', {
            stage: 'repair',
            kind: repaired.kind,
            reason: repaired.errorSummary.slice(0, 200),
            outputLength: repair.text.length,
            fellBackToFirstReply: chosen !== null && repaired.value === undefined,
          });
        }
      } else {
        chosen = validated.value ?? null;
      }
    }

    if (chosen === null) return crossFailed();
    raw = chosen;

    // Both calls' tokens are summed regardless of WHICH reply is used — the money was
    // spent either way.
    tokensIn = first.tokensIn + (repair?.tokensIn ?? 0);
    tokensOut = first.tokensOut + (repair?.tokensOut ?? 0);
  }

  // 10) The validation layers, IN THIS ORDER (PRD §5.5). The order is load-bearing:
  //     layer 2 must run AFTER layer 1, or a requirement whose only binding was just
  //     dropped would never get its compensating gap and Q1 coverage would silently
  //     fail (§4 R5, pinned by a test).
  //
  //     (a) Layer 1 — referential integrity: projectId ∈ library.
  const { result: keptBindings, dropped: droppedBindings } = filterByReferentialIntegrity(
    raw.bindings,
    getValidProjectIds(library),
  );

  //     (b) ANOMALY SCAN — not a layer. PRD §5.5 fixes the list at FOUR layers;
  //         inventing a fifth filter here is out of scope, so hallucinated requirement
  //         ids and double-covered requirements are COUNTED AND REPORTED, never
  //         silently dropped (§4 R7). D11: a requirement carrying ≥ 1 binding counts as
  //         BOUND, and the contradicting gap stays in the persisted ledger for
  //         transparency (PRD's "宁可暴露不完整，不静默吞掉").
  const jdRequirementIds = new Set(job.jd.requirements.map((r) => r.id));
  const boundIds = new Set(keptBindings.map((b) => b.requirementId));
  const doubleCoveredRequirementIds = [
    ...new Set(raw.gaps.map((g) => g.requirementId).filter((rid) => boundIds.has(rid))),
  ];
  const unknownRequirementIds = [
    ...new Set([
      ...unknownIds(keptBindings, jdRequirementIds),
      ...unknownIds(raw.gaps, jdRequirementIds),
    ]),
  ];

  //     (c) Layer 2 — requirement coverage: anything the model covered in NEITHER array
  //         gets an injected gap marked 'uncovered — rerun' (FND-07's UNCOVERED_MARKER).
  const { result: ledger, injectedGaps } = ensureRequirementCoverage(job.jd, {
    bindings: keptBindings,
    gaps: raw.gaps,
  });

  // 11) SCORE — pure code, no model call (PRD §5.1 "模型不输出分数"). A throw is a code
  //     bug in the scorer (its own FitReport.parse self-check), never a model problem.
  let fit: FitReport;
  try {
    fit = computeFitReport(ledger, job.jd, raw.hardRequirements);
  } catch (err) {
    console.error('[fit] scoring failed', {
      userId,
      jobId: id,
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
    return json({ error: 'score_failed' }, 500);
  }

  // 12) Persist BOTH columns in one statement (FIT-01's attachLedgerAndFit — there is
  //     no legitimate "ledger without fit" state). `null` means the row vanished
  //     mid-request (e.g. an account deletion cascade): a 404, not a 500. The paid call
  //     is lost — unavoidable and accepted (§4 R3).
  let completed: import('@/lib/db/queries/jobs').PersistedJob | null;
  try {
    const { attachLedgerAndFit } = await import('@/lib/db/queries/jobs');
    completed = await attachLedgerAndFit(userId, id, ledger, fit);
  } catch (err) {
    console.error('[fit] job write failed', {
      userId,
      jobId: id,
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
    return json({ error: 'job_write_failed' }, 500);
  }
  if (!completed) return json({ error: 'not_found' }, 404);

  const droppedCount = droppedBindings.length + injectedGaps.length;

  // 13) Usage on SUCCESS only, exactly once, with op 'cross' (PRD §8.4's dropped/stage
  //     accounting). SCORE produces no usage row of its own — its cost is folded into
  //     this one `cross` event (04-fit/README.md's decision).
  //
  //     Wrapped in try/catch for the same reason FIT-01 wraps its own: the row is
  //     ALREADY committed here, so a failure to record usage must not turn a successful
  //     Fit into a 500 the client would (reasonably) retry — a retry would now hit the
  //     already_fitted guard and lose the report entirely. recordUsage itself swallows
  //     DB errors (FND-10); this catches a failure of the lazy IMPORT, which reaches
  //     `@/db/index`.
  //
  //     KNOWN GAP, carried verbatim from FIT-01 and deliberately NOT fixed here: a paid
  //     call that completes but fails validation costs real money and writes no
  //     usage_events row, so the breaker under-counts it. FND-10 supports
  //     `status: 'failure'` for exactly this, but recording failures WOULD consume quota
  //     (FND-06 counts rows regardless of status) — a product/cost decision for Horace,
  //     and both routes must change together or not at all. Do NOT unilaterally start
  //     recording failures here.
  try {
    const { recordUsage } = await import('@/lib/usage/record');
    await recordUsage({
      userId,
      op: 'cross',
      tokensIn,
      tokensOut,
      searches: 0,
      durationMs: Date.now() - startedAt,
      droppedCount,
    });
  } catch (err) {
    console.error('[fit] usage recording failed after a committed job write', {
      userId,
      jobId: id,
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
  }

  // 14) `no-store`: the body carries the user's JD, their ledger and library-derived
  //     evidence; a shared cache holding it would be a cross-user leak.
  return NextResponse.json(
    {
      ...completed,
      dropped: {
        count: droppedCount,
        bindings: droppedBindings,
        uncoveredRequirementIds: injectedGaps.map((g) => g.requirementId),
      },
      anomalies: { doubleCoveredRequirementIds, unknownRequirementIds },
    },
    { status: 200, headers: NO_STORE },
  );
}
