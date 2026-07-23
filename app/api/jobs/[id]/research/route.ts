import { NextResponse } from 'next/server';

import { requireUserId, UnauthorizedError } from '@/lib/auth/session';
import { PRIMARY_MODEL } from '@/lib/config/models';
import {
  buildResearchRepairUserText,
  buildResearchUserText,
  RESEARCH_MAX_SEARCHES,
  RESEARCH_MAX_TOKENS,
  RESEARCH_SYSTEM_PROMPT,
} from '@/lib/research/prompt';
import { Intel } from '@/lib/schemas/pipeline';

// PRP-01 Deliverable 2 — the RESEARCH stage route: LLM + web_search tool → Intel.
//
// PRD ANCHORS
//   §5.1 RESEARCH row: "company + role → Intel（web_search tool）；snapshot、recent ≤ 3
//        （每条带 soWhat）、engineering 信号 ≤ 3、talkingPoints ≤ 3；查无实据返回空数组,
//        禁止编造；失败标记 fail，简报照常（P3)".
//   §2 P3 "Degrade, don't block": a RESEARCH failure (search error, timeout, unusable
//        reply) must NOT block the user — it returns a friendly 200 { intel:null,
//        failed:true }, never a 4xx/5xx. See THE DEGRADE CONTRACT below.
//   §2 P4 "重操作（web 搜索、面试简报）只在用户显式进入下一阶段时发生" — the 403/409
//        funnel gates below enforce this server-side (D3).
//   §5.4 unlock condition: Prep is reachable only when job.status === 'interviewing'.
//   §8.3 "全部查询以 session userId 约束；per-user 3 prep/day；全局熔断" — userId comes
//        only from the session; the prep bucket is charged once here.
//   §8.4 tokens/searches/cost/duration accounting via recordUsage on success.
//   §12 "搜索结果污染" — mitigated by D1's minimal input, the untrusted-content clause
//        covering retrieved pages, the fixed four-key Zod shape, and D9c's source year
//        inside recent[].headline (Intel has no url/date field — plan §5 Q3).
//
// QUOTA: this route charges the `prep` bucket EXACTLY ONCE, before the paid call, for the
// WHOLE two-call Prep operation (RESEARCH here + PRP-02's REHEARSE). FND-06's
// QUOTA_OP_TO_USAGE_OP maps prep → 'research' and its comment obliges each consumer to
// re-confirm the mapping: RE-CONFIRMED for PRP-01 — this route records usage op
// 'research' (the mapped op), so the one row it writes on success IS the row that
// consumes the prep unit. PRP-02's later recordUsage(op:'rehearse') MUST NOT re-check
// `prep` quota (PRP-02 ticket, Non-goals) — counting 'rehearse' would be a second charge.
//
// THE DEGRADE CONTRACT (docs/plans/PRP-01.md §0.1 D4/D5) — the load-bearing design here:
// everything from the paid call OUTWARD degrades to 200 { intel:null, failed:true } —
// transport error, timeout, non-2xx from Anthropic, a search round that never really ran
// (D5), and a reply still unusable after the one repair. Everything BEFORE it is an
// ordinary HTTP status (401/403/404/409/429/500/503). A getJob THROW (row drift) is a
// 500, NOT a degrade — it is not a research failure. Rationale (ticket Deliverable 2f):
// an HTTP error says "something is wrong with your request/session"; a best-effort
// external dependency failing is an EXPECTED case the client must render (PRD §5.7
// "research fail 标红但简报照常渲染") and carry on from — a distinct, non-exceptional case.
//
// D5 SEARCH GUARD: a reply is only usable if the web search MECHANISM actually ran and
// returned a result set. Zero server_tool_use requests ⇒ the findings came from
// parametric memory (PRD §12's pollution at its worst) ⇒ degrade, even if the JSON is
// perfect. Every search erroring ⇒ degrade. But an EMPTY result array counts as a real
// search — a genuinely obscure/fake company legitimately yields "found nothing", which is
// an honest SUCCESS (failed:false), not a degrade. So the gate is "≥ 1 result block with
// ARRAY content", not "≥ 1 hit".
//
// BUILD-TIME SAFETY (the FND-08 bug class): `next build`'s "Collecting page data" phase
// statically imports every app/api/**/route.ts, and db/index.ts THROWS at import time
// when DATABASE_URL is unset (an intentional, tested FND-05 fail-fast). `@/lib/config/
// quota`, `@/lib/usage/record` and `@/lib/db/queries/jobs` reach `@/db/index`, so they are
// imported LAZILY inside the handler. Guarded by a test that imports this module with
// DATABASE_URL blank and no mocks. `@/lib/auth/session`, `@/lib/config/models`,
// `@/lib/research/prompt`, `@/lib/schemas/pipeline` and `next/server` are safe statically.
//
// WIRE CONTRACT — PRP-02/PRP-03/PRP-04 code against this, do not improvise. Branch on the
// `error` STRING (two distinct 503s share the status code):
//
//   POST /api/jobs/{id}/research        NO request body is read at all
//
//     200 { "intel": <Intel>, "failed": false }        Cache-Control: no-store
//     200 { "intel": null,    "failed": true  }        RESEARCH degraded — PRD §2 P3
//     401 { "error":"Unauthorized" }
//     403 { "error":"not_interviewing" }        job.status !== 'interviewing' (D3)
//     404 { "error":"not_found" }               unknown id OR another user's job
//     409 { "error":"fit_not_ready" }           job.ledger / job.fit absent (D3)
//     429 { "error":"quota_exceeded", "op":"prep", "resetAt": number }
//     500 { "error":"job_read_failed" }         stored-row drift (a THROW, never a 404)
//     503 { "error":"global_breaker_tripped" | "quota_check_failed" }
//
// SINGLE-FLIGHT INSTRUCTION TO PRP-03/PRP-04: issue AT MOST ONE automatic RESEARCH per
// mount behind a `useRef` single-flight guard, and offer only a MANUAL "try again". A
// degraded call is a friendly 200 that records NO usage_events row (§4 R1/D13), so it
// consumes no quota and is invisible to the global breaker — an auto-retry loop on a
// permanently-degrading route would be both FREE and UNBOUNDED paid searches. Same
// posture 04-fit's Fit auto-runner already documents.
//
// Only POST is exported — Next.js answers every other method with 405 by itself.
//
// CSRF: auth.config.ts sets no cookie override, so Auth.js v5 defaults apply (httpOnly,
// sameSite 'lax'); a cross-site POST carries no session cookie and gets a 401 before any
// spend. No extra token — same posture as every peer route.
//
// LOGGING: never log the model's raw text, the returned Intel, job.jdRaw/job.jd, request
// headers (they carry ANTHROPIC_API_KEY), a raw Drizzle/pg error, OR company/role (which
// companies a user is interviewing at is itself sensitive). Status codes, error
// name/message, Zod issue PATHS, and counts/lengths only.

export const runtime = 'nodejs';
// Vercel Hobby ceiling. Every timeout below stays under it on purpose.
export const maxDuration = 60;

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
/** Per-call upstream timeout. Up to RESEARCH_MAX_SEARCHES searches + generation. */
const ANTHROPIC_TIMEOUT_MS = 45_000;
/**
 * The whole handler's budget, below `maxDuration`, so a slow upstream surfaces as OUR
 * degrade rather than a platform 504 with no error contract. PRD §5.1's "Prep ≤ 90s" p50
 * budgets RESEARCH + PRP-02's REHEARSE together, so this single call sits well under it.
 */
const HANDLER_DEADLINE_MS = 55_000;
/** Below this remaining budget, skip the repair rather than get killed mid-flight. */
const MIN_REPAIR_BUDGET_MS = 8_000;

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * The web_search tool block — the single place its version string lives (D10's ⚠️).
 * `web_search_20250305` is an Anthropic-side contract this repo CANNOT pin or type-check;
 * verify it against Anthropic's current docs (and whether an `anthropic-beta` header is
 * required) during the manual smoke run BEFORE P4 sign-off (§4 R4/R5). A wrong string is
 * an HTTP 400 that this route degrades to a friendly 200 forever, with a green suite.
 */
const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: RESEARCH_MAX_SEARCHES,
} as const;

type Ctx = { params: Promise<{ id: string }> };

type AnthropicCall = {
  text: string;
  blocks: unknown[];
  tokensIn: number;
  tokensOut: number;
  truncated: boolean;
  reportedSearches: number;
};

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status });
}

// Postgres rejects U+0000 in `jsonb`. This route persists NOTHING, but the Intel it
// returns travels client-side into PRP-02's briefs.intel jsonb write — without this guard
// PRP-01 would export a payload that detonates in someone else's route (D11).
const NUL = String.fromCharCode(0);
function hasNulByte(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(NUL);
  if (Array.isArray(value)) return value.some(hasNulByte);
  if (value && typeof value === 'object') return Object.values(value).some(hasNulByte);
  return false;
}

/**
 * Pulls the JSON object out of a model reply: strips an optional code fence, then slices
 * from the first `{` to the last `}`. The prompt forbids fences; this tolerates one
 * anyway rather than burning a paid repair call on a cosmetic violation.
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

function isTextBlock(block: unknown): block is { type: 'text'; text: string } {
  return (
    !!block &&
    typeof block === 'object' &&
    (block as { type?: unknown }).type === 'text' &&
    typeof (block as { text?: unknown }).text === 'string'
  );
}

/**
 * Extracts the FINAL answer text from a tool-using reply (D8). A web-search reply
 * legitimately interleaves prose ("Let me look up Acme…"), tool blocks, and the final
 * JSON. We take the text blocks AFTER the last server_tool_use / web_search_tool_result
 * block; if that yields no `{` (e.g. the model put its answer before a trailing tool
 * echo, or there were no tool blocks at all), we fall back to joining ALL text blocks.
 * Copying FIT-02's "join every text block" verbatim would splice the search preamble into
 * the payload and fail extraction (or burn a paid repair) on a perfectly good reply.
 */
function extractFinalText(blocks: unknown[]): string {
  if (!Array.isArray(blocks)) return '';
  let lastToolIdx = -1;
  blocks.forEach((b, i) => {
    const t = (b as { type?: unknown })?.type;
    if (t === 'server_tool_use' || t === 'web_search_tool_result') lastToolIdx = i;
  });
  const after = blocks
    .slice(lastToolIdx + 1)
    .filter(isTextBlock)
    .map((b) => b.text)
    .join('');
  if (after.includes('{')) return after;
  return blocks
    .filter(isTextBlock)
    .map((b) => b.text)
    .join('');
}

/**
 * Search accounting (D5/D6), computed from the FIRST reply only (the repair carries no
 * tools). Walks the blocks once:
 *   - a `server_tool_use` block with name 'web_search' is a request;
 *   - a `web_search_tool_result` block whose `content` is an ARRAY is a real result set
 *     (an EMPTY array included — D5c: an obscure company that legitimately found nothing);
 *   - a `web_search_tool_result` block whose `content` is an object carrying `error_code`
 *     is an errored search;
 *   - any other block shape counts as neither (defensive — the block names, the error
 *     shape and the usage field are all un-type-checkable Anthropic contracts, §4 R5).
 *
 * `requests` takes the MAX of the block count and the usage-reported count so the normal
 * case (they agree) is exact and any disagreement OVER-reports — the safe direction for a
 * cost breaker, since under-reporting silently under-meters real spend (D6).
 */
function summariseSearches(
  blocks: unknown[],
  reportedSearches: number,
): { requests: number; results: number; errors: number } {
  let blockRequests = 0;
  let results = 0;
  let errors = 0;
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      const b = block as { type?: unknown; name?: unknown; content?: unknown };
      if (b?.type === 'server_tool_use' && b?.name === 'web_search') {
        blockRequests += 1;
      } else if (b?.type === 'web_search_tool_result') {
        if (Array.isArray(b.content)) {
          results += 1;
        } else if (
          b.content &&
          typeof b.content === 'object' &&
          'error_code' in (b.content as Record<string, unknown>)
        ) {
          errors += 1;
        }
      }
    }
  }
  return { requests: Math.max(blockRequests, reportedSearches), results, errors };
}

/**
 * One Anthropic Messages call. Returns `null` on any transport/HTTP/timeout failure.
 *
 * Uses the global `fetch` with no injection seam, deliberately (same choice as the peer
 * routes): tests stub `globalThis.fetch`. `withTools` toggles the web_search tool block —
 * ON for the first call, OFF for the repair (D7: the repair fixes STRUCTURE and must not
 * buy a second round of paid searches).
 */
async function callAnthropic(
  userText: string,
  timeoutMs: number,
  opts: { withTools: boolean },
): Promise<AnthropicCall | null> {
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
        max_tokens: RESEARCH_MAX_TOKENS,
        system: RESEARCH_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
        ...(opts.withTools ? { tools: [WEB_SEARCH_TOOL] } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      // The upstream error.type / message is what makes the D10 tool-version failure mode
      // diagnosable at all (§4 R4). NEVER log the request body (it carries the prompt).
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
      console.error('[research] anthropic returned non-2xx', {
        status: res.status,
        withTools: opts.withTools,
        upstreamType,
        upstreamMessage,
      });
      return null;
    }

    const data = await res.json();
    const blocks: unknown[] = Array.isArray(data?.content) ? data.content : [];

    return {
      text: extractFinalText(blocks),
      blocks,
      tokensIn: Number(data?.usage?.input_tokens ?? 0),
      tokensOut: Number(data?.usage?.output_tokens ?? 0),
      truncated: data?.stop_reason === 'max_tokens',
      reportedSearches: Number(data?.usage?.server_tool_use?.web_search_requests ?? 0) || 0,
    };
  } catch (err) {
    console.error('[research] anthropic call failed', {
      name: err instanceof Error ? err.name : 'unknown',
      withTools: opts.withTools,
    });
    return null;
  }
}

type Validation = { ok: true; value: Intel } | { ok: false; errorSummary: string };

/**
 * Validates one RESEARCH reply against the D11 hard-failure classes, in order:
 * truncation, no extractable JSON object, `Intel.safeParse` failure (INCLUDING the .max(3)
 * caps — over-cap arrays are repaired, never silently sliced to 3, because the caps are
 * PRD §5.1 rules, not our formatting preference), a NUL byte anywhere, or a blank required
 * string. The blank-string checks are NOT redundant with Zod: `Intel` has no .min(1)
 * anywhere, so `''` is schema-legal — but a blank `snapshot` renders as an empty card and
 * a blank `soWhat` is a recent entry with its point missing. There is no "soft" class
 * (unlike CROSS).
 */
function validateCall(call: AnthropicCall): Validation {
  if (call.truncated) {
    return { ok: false, errorSummary: 'the reply was cut off before the JSON ended' };
  }
  const parsedJson = extractJsonObject(call.text);
  if (parsedJson === null) {
    return { ok: false, errorSummary: 'the reply was not valid JSON' };
  }
  const parsed = Intel.safeParse(parsedJson);
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
    parsed.data.snapshot.trim() === '' ||
    parsed.data.recent.some((r) => r.headline.trim() === '' || r.soWhat.trim() === '') ||
    parsed.data.engineeringSignals.some((s) => s.trim() === '') ||
    parsed.data.talkingPoints.some((t) => t.trim() === '');
  if (blank) {
    return {
      ok: false,
      errorSummary:
        'snapshot, every recent[].headline and recent[].soWhat, and every engineeringSignals[] and talkingPoints[] entry must be a non-empty string',
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * The PRD §2 P3 degrade response: a friendly 200 with a `failed` flag, NOT a 4xx/5xx.
 * One call site per reason, so a permanently-degrading route is diagnosable from the log
 * without changing the body shape PRP-02 parses (D2). NEVER logs company/role or text.
 */
function degraded(reason: string, context: Record<string, unknown>): NextResponse {
  console.error('[research] degraded', { reason, ...context });
  return NextResponse.json({ intel: null, failed: true }, { status: 200, headers: NO_STORE });
}

export async function POST(_req: Request, ctx: Ctx): Promise<NextResponse> {
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

  // 2) The job id, from the path. NO REQUEST BODY IS READ — this route takes no input
  //    beyond the id, so anything a client sends is ignored entirely (pinned by a test).
  //    Next 15 hands `params` as a PROMISE; a non-Promise type type-checks in isolation
  //    and fails `next build`'s generated route-type check.
  const { id } = await ctx.params;

  // 3) The job, scoped to its owner. `null` covers BOTH "no such job" and "another user's
  //    job" — indistinguishable by design (PRD §8.3), so both are the same 404 body; a 403
  //    would confirm the id exists. A THROW is row drift (FIT-01's loud-failure policy),
  //    which is a 500, NOT a degrade — it is not a research failure (D4).
  let job: import('@/lib/db/queries/jobs').PersistedJob | null;
  try {
    const { getJob } = await import('@/lib/db/queries/jobs');
    job = await getJob(userId, id);
  } catch (err) {
    console.error('[research] job read failed', {
      userId,
      jobId: id,
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
    return json({ error: 'job_read_failed' }, 500);
  }
  if (!job) return json({ error: 'not_found' }, 404);

  // 4) The D3 funnel gates, BOTH before any spend. These are deliberate ADDITIONS to the
  //    ticket's Deliverable 2 list (which is silent on both) — recorded in the ticket
  //    Changelog and flagged to the Reviewer (plan §5 Q6).
  //
  //    (a) PRD §5.4 makes status === 'interviewing' THE unlock condition for Prep, and
  //        §2 P4 names this exact call ("重操作（web 搜索…）只在用户显式进入下一阶段时发生")
  //        as the thing being gated. Without this, the cheap half of Prep (PRP-02 already
  //        gates status) would be gated while the EXPENSIVE half — the only call in the
  //        app that spends real money on web searches — would not.
  if (job.status !== 'interviewing') return json({ error: 'not_interviewing' }, 403);

  //    (b) A whole-Prep-operation integrity gate: PRP-02's REHEARSE 409s without
  //        ledger/fit, so a Prep that provably cannot finish would otherwise still burn the
  //        day's prep unit PLUS real search money. NOTE: RESEARCH itself does NOT read
  //        ledger/fit; this is not an input requirement, it is a "don't start an operation
  //        that can't complete" gate.
  if (job.ledger === null || job.fit === null) return json({ error: 'fit_not_ready' }, 409);

  // 5) Quota — the ONE `prep` charge for the whole Prep operation (see the header's QUOTA
  //    note; QUOTA_OP_TO_USAGE_OP.prep === 'research' RE-CONFIRMED there). The lazy import
  //    sits INSIDE the try because `@/lib/config/quota` statically imports `@/db/index`
  //    and can throw at import time on a misconfigured env. A THROW ⇒ 503 quota_check_failed
  //    (fail CLOSED — no paid call without a working counter).
  let quotaMod: typeof import('@/lib/config/quota');
  try {
    quotaMod = await import('@/lib/config/quota');
    const { allowed, resetAt } = await quotaMod.checkAndIncrementQuota(userId, 'prep');
    if (!allowed) {
      return json({ error: 'quota_exceeded', op: 'prep', resetAt }, 429);
    }
  } catch (err) {
    console.error('[research] quota check failed; failing closed', {
      userId,
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
    return json({ error: 'quota_check_failed' }, 503);
  }

  // 6) The global spend breaker (PRD §8.3), re-checked immediately before this route's own
  //    paid call. Order AFTER quota per Deliverable 2(c)→(d). A THROW returns the SAME 503
  //    (fail CLOSED): the client cannot act differently on "tripped" vs "misconfigured",
  //    and the operator sees the real reason in the log.
  try {
    const breaker = await quotaMod.checkGlobalBreaker();
    if (breaker.tripped) return json({ error: 'global_breaker_tripped' }, 503);
  } catch (err) {
    console.error('[research] global breaker check failed; failing closed', {
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
    return json({ error: 'global_breaker_tripped' }, 503);
  }

  // 7) THE PAID CALL — WITH tools. From here on EVERY failure DEGRADES (D4).
  const first = await callAnthropic(
    buildResearchUserText(job.company, job.role),
    ANTHROPIC_TIMEOUT_MS,
    { withTools: true },
  );
  if (!first) return degraded('upstream_error', { userId, jobId: id });

  // 8) Search accounting on the FIRST reply, BEFORE validation — so a hopeless reply never
  //    buys a repair (D5). Proceed ONLY if the search MECHANISM ran and returned ≥ 1 array
  //    result set (empty array included, D5c). Distinguish the two failure reasons only
  //    for the log.
  const s = summariseSearches(first.blocks, first.reportedSearches);
  if (s.requests === 0) {
    // The findings, if any, came from parametric memory — unsourced and undetectable by
    // the user. PRD §12's "搜索结果污染" at its worst; "禁编造" is the stated mitigation.
    return degraded('no_search', {
      userId,
      jobId: id,
      requests: s.requests,
      results: s.results,
      errors: s.errors,
      outputLength: first.text.length,
    });
  }
  if (s.results === 0) {
    // Searches ran but every one errored — no result set to ground anything on.
    return degraded('search_error', {
      userId,
      jobId: id,
      requests: s.requests,
      results: s.results,
      errors: s.errors,
      outputLength: first.text.length,
    });
  }

  // 9) Validate + the ONE repair turn (D7/D11), deadline-aware. DELIBERATE CONTRAST with
  //    FIT-02's 422 / other routes' error status: PRD §2 P3 scopes "degrade, don't block"
  //    to exactly this best-effort stage, so an unusable reply here is a 200, not a 4xx.
  let chosen: Intel | null = null;
  let repair: AnthropicCall | null = null;

  const firstValidation = validateCall(first);
  if (firstValidation.ok) {
    chosen = firstValidation.value;
  } else {
    const budgetMs = Math.min(ANTHROPIC_TIMEOUT_MS, HANDLER_DEADLINE_MS - (Date.now() - startedAt));
    console.error('[research] first reply unusable', {
      userId,
      jobId: id,
      reason: firstValidation.errorSummary.slice(0, 200),
      outputLength: first.text.length,
      budgetMs,
      attempting: budgetMs >= MIN_REPAIR_BUDGET_MS,
    });
    if (budgetMs >= MIN_REPAIR_BUDGET_MS) {
      // No tools on the repair — it fixes STRUCTURE only and must not buy more searches.
      repair = await callAnthropic(
        buildResearchRepairUserText(first.text, firstValidation.errorSummary),
        budgetMs,
        { withTools: false },
      );
      if (repair) {
        const repairValidation = validateCall(repair);
        if (repairValidation.ok) {
          chosen = repairValidation.value;
        } else {
          console.error('[research] repair reply also unusable', {
            userId,
            jobId: id,
            reason: repairValidation.errorSummary.slice(0, 200),
            outputLength: repair.text.length,
          });
        }
      }
    }
    if (chosen === null) {
      return degraded('unusable_reply', { userId, jobId: id, repaired: repair !== null });
    }
  }

  // 10) SUCCESS ONLY: record usage exactly once with op 'research' (D6/D12/D13). Both
  //     calls' tokens are summed (the money was spent either way); the repair's searches
  //     are zero by construction, so `searches` counts only the first call's blocks.
  //     droppedCount: 0 — none of PRD §5.5's four validation layers apply to Intel (D12).
  //
  //     Wrapped in try/catch for the same reason the peer routes wrap theirs: the paid call
  //     already happened, so a failure to record usage must not turn a good result into a
  //     500 the client would retry (buying another paid call). recordUsage itself swallows
  //     DB errors (FND-10); this catches a failure of the lazy IMPORT, which reaches
  //     `@/db/index`.
  //
  //     KNOWN GAP, carried verbatim from FIT-02/FIT-01 and deliberately NOT fixed here
  //     (§4 R1/D13): a DEGRADED call writes no usage_events row, so it consumes no prep
  //     quota and its real spend — INCLUDING PAID SEARCHES — is invisible to the global
  //     breaker. Sharper here than on any peer route because the failure is a friendly 200
  //     a UI may treat as retryable. FND-10 supports status:'failure', but recording
  //     failures WOULD consume quota (FND-06 counts rows regardless of status) — a repo-wide
  //     product/cost decision for Horace (plan §5 Q4). Do NOT unilaterally start recording
  //     failures here; all stage routes change together or not at all.
  try {
    const { recordUsage } = await import('@/lib/usage/record');
    await recordUsage({
      userId,
      op: 'research',
      tokensIn: first.tokensIn + (repair?.tokensIn ?? 0),
      tokensOut: first.tokensOut + (repair?.tokensOut ?? 0),
      searches: s.requests,
      durationMs: Date.now() - startedAt,
      droppedCount: 0,
    });
  } catch (err) {
    console.error('[research] usage recording failed after a paid call', {
      userId,
      jobId: id,
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
  }

  // `no-store`: the body carries company intel tied to a specific user's job search; a
  // shared cache holding it would be a cross-user leak (§4 S4).
  return NextResponse.json({ intel: chosen, failed: false }, { status: 200, headers: NO_STORE });
}
