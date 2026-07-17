# Implementation plan — FND-06: Model, pricing, and quota configuration

Ticket: [docs/prd/01-foundation/tickets/FND-06-model-pricing-quota-config.md](../prd/01-foundation/tickets/FND-06-model-pricing-quota-config.md)
Sub-PRD: [docs/prd/01-foundation/README.md](../prd/01-foundation/README.md)
Master spec: [docs/PRD.md](../PRD.md) §8.1 (model-pin policy: "模型 pin 在 config"; quota storage: "配额用 Postgres 计数器"), §9 (pricing table + raw unit prices: "Sonnet 5 = $2 in / $10 out per MTok（8/31 前介绍价；之后 $3/$15…）；web search $10 / 1,000 次；Haiku 4.5（judge）$1/$5"), §8.3 ("配额：per-user 每日 10 fit / 5 tailor / 3 prep；全局日花费熔断阈值（env）")
Breakdown plan file-ownership table: [docs/prd/breakdown-plan.md](../prd/breakdown-plan.md) line 50 (`lib/config/**` → `01-foundation`/FND-06: "模型 pin、价格、配额数字与 `checkAndIncrementQuota()` / `checkGlobalBreaker()`")
Depends on (merged): [docs/plans/FND-01.md](FND-01.md) (repo/toolchain — `.env.example` exists, vitest/tsconfig scaffolding), [docs/plans/FND-05.md](FND-05.md) (`db/schema.ts`'s `usageEvents` table + composite index, `db/index.ts`'s `db` client, and the established local-Postgres-substitute convention: PGlite + `drizzle-orm/pglite`, explicitly directed at FND-06 by `01-foundation/README.md`'s v0.4 changelog line: "下游 FND-06 / FND-10 请复用 `@electric-sql/pglite` + `drizzle-orm/pglite`, 而非 pg-mem")
Downstream (read this plan's decisions before starting): FND-10 (`lib/usage/record.ts` calls this ticket's `estimateCostUsd`, never accepts a caller-supplied `costUsd`), EVL-02 (imports `JUDGE_MODEL` from `models.ts`; judge-call cost goes through FND-10's `recordUsage()`, not `estimateCostUsd` directly), FIT-01/FIT-02 (call `checkAndIncrementQuota(userId, 'fit')` once at FIT-01, `checkGlobalBreaker()` at both FIT-01 and FIT-02), TLR-01 (calls both once), PRP-01/PRP-02 (call `checkAndIncrementQuota(userId, 'prep')` once at PRP-01 only; `checkGlobalBreaker()` at both). **This plan's §2.3 documents a load-bearing cross-ticket mapping (which `usage_events.op` value each quota bucket counts) sourced directly from FIT-01/TLR-01/PRP-01's own ticket text — read §2.3 and §4's "cross-ticket coordination risk" note before building any of those four tickets.**

This plan is cold-startable: a Builder with no access to the planning conversation can execute it from this file plus the ticket alone.

## 0. Repo-state check performed for this plan (do not re-derive, just confirm unchanged)

Verified at planning time (2026-07-18) by direct inspection, not assumption:

- `git log --oneline -1`: HEAD is `a807f81` (merge ticket/FND-05 into main). `git status`: working tree clean, up to date with `origin/main`. **`a807f81` is the base commit** the Builder's diff should be measured against.
- `lib/config/` does not exist yet — this ticket creates it from scratch (`models.ts`, `pricing.ts`, `pricing.test.ts`, `quota.ts`, `quota.test.ts`).
- `db/schema.ts` (FND-05, merged) exports `usageEvents` — columns `id, userId (FK→users.id, cascade), op (usageOpEnum, not null), tokensIn (integer), tokensOut (integer), searches (integer), costUsd (numeric, mode:'number'), durationMs (integer), createdAt (bigint, mode:'number', epoch-ms)` — plus a composite index `usage_events_user_op_created_idx` on `(userId, op, createdAt)`, purpose-built for exactly the `WHERE userId = ? AND op = ? AND createdAt >= ?` query pattern this ticket needs. Also exports `usageOpEnum` (pg enum, values `['parse','read','cross','tailor','research','rehearse']`).
- `db/index.ts` (FND-05, merged) exports `db` (a `drizzle-orm/neon-http` client) and **throws at import time** if `process.env.DATABASE_URL` is unset. This ticket's production code imports `db` from `@/db/index` the same way; this ticket's *tests* must not trigger that import-time throw (see §2.5 — tests mock `@/db/index` entirely, never importing the real module).
- `lib/schemas/persisted.ts` (FND-04, merged) exports `UsageOp` (Zod enum + inferred type) = `'parse' | 'read' | 'cross' | 'tailor' | 'research' | 'rehearse'` — **no `'fit'`, `'prep'`, or `'score'` value**. This is the single most important fact this plan works around: FND-06's own quota buckets (`fit`/`tailor`/`prep`, per PRD §8.3) are a *different, product-level* vocabulary from `UsageOp` (a *pipeline-stage* vocabulary), and only `'tailor'` happens to be spelled the same in both. §2.3 below resolves the mapping.
- `vitest.config.ts`'s `test.include` already contains `'lib/**/*.test.ts'` (widened by FND-02's writeback, reused by every subsequent `lib/**` ticket per `01-foundation/README.md`'s v0.3 changelog) — `lib/config/*.test.ts` is already discovered by `pnpm test` with **no config change needed** by this ticket.
- `package.json` already has `@electric-sql/pglite` (`^0.5.4`) as a devDependency and `drizzle-orm`/`drizzle-kit` as (dev)dependencies, added by FND-05 — **no new dependency needed** by this ticket. `db/migrations/0000_*.sql` (the one committed migration) already creates the full `usage_events` table with its composite index — this ticket's tests apply that same migration via `drizzle-orm/pglite/migrator`'s `migrate()`, the exact pattern established in `db/migrate.test.ts` (Tier 3).
- `.env.example` (FND-01, appended by nothing since) currently contains exactly: `ANTHROPIC_API_KEY=`, `DATABASE_URL=`, `AUTH_SECRET=`, `AUTH_GOOGLE_ID=`, `AUTH_GOOGLE_SECRET=`, `RESEND_API_KEY=`, `RESEND_FROM_EMAIL=` (seven bare `KEY=` lines, no comments, no blank-line grouping). This ticket appends one more bare line, `GLOBAL_DAILY_SPEND_LIMIT_USD=`, matching the file's existing plain style — no comment block, consistent with every existing line.
- **Load-bearing finding — the `fit`/`tailor`/`prep` → `UsageOp` mapping is already decided in downstream ticket text, not something this ticket invents from scratch.** `docs/prd/04-fit/tickets/FIT-01-job-creation-status-route.md` line 56 (quoted verbatim): "`recordUsage()` (FND-10) with `op: 'read'` — note this is `'read'`, not `'fit'`, because `UsageOp` (FND-04) has no `'fit'` value... the QUOTA bucket is `'fit'` (FND-06's `DAILY_QUOTA` key) while the USAGE-EVENT op is `'read'` — these are two different enums serving different purposes, do not conflate them." That same ticket's Deliverable 3(d) charges the `fit` quota once, at FIT-01 (before READ), and FIT-02 (line 40 of `FIT-02-cross-score-route.md`) explicitly does **not** re-check quota when it later calls `recordUsage(op:'cross')`. So a single completed Fit action produces **two** `usage_events` rows (`op:'read'` then later `op:'cross'`), but only one quota charge, gated on `'read'`. Symmetrically, `docs/prd/06-prep/tickets/PRP-01-research-route.md` line 49 charges the `prep` quota once, before RESEARCH, calling `recordUsage(op:'research')` on success (line 49(g)); PRP-02 (line 39 of `PRP-02-rehearse-route.md`) explicitly does **not** re-check `prep` quota before its own `recordUsage(op:'rehearse')` call. `docs/prd/05-tailor/tickets/TLR-01-tailor-route.md` line 54 charges `tailor` once and calls `recordUsage(op:'tailor')` — a direct 1:1 name match, no ambiguity. **Conclusion, used in §2.3: `fit` counts `usage_events` rows where `op = 'read'`; `tailor` counts `op = 'tailor'`; `prep` counts `op = 'research'`.** Counting `'cross'` or `'rehearse'` instead (or in addition) would double-count, since those ops are written by the *second* call of a two-call user-facing action that was already charged once at the *first* call.
- `04-fit/README.md` and `06-prep/README.md` both independently flag the underlying "one quota charge per multi-call user-facing action" architectural decision as the pre-existing ADR-0001 candidate slot (`docs/prd/breakdown-plan.md` §6, open question #8) — this plan does not re-flag that decision as a new ADR candidate (see §6); it only implements the *counting mechanics* of an already-decided policy.

## 1. Scope

**In scope** (per ticket Deliverables 1–4, File-scope):

- New file `lib/config/models.ts` — `PRIMARY_MODEL`/`JUDGE_MODEL` constants.
- New file `lib/config/pricing.ts` — `PRICING` rate table + `estimateCostUsd()` pure function.
- New file `lib/config/pricing.test.ts` — unit tests for `estimateCostUsd`/`PRICING`.
- New file `lib/config/quota.ts` — `DAILY_QUOTA` + `checkAndIncrementQuota()` + `checkGlobalBreaker()`, querying `usage_events` (FND-05) directly.
- New file `lib/config/quota.test.ts` — unit/integration tests for the above, against a PGlite-backed Postgres substitute.
- `.env.example` — append `GLOBAL_DAILY_SPEND_LIMIT_USD=` (one line, append-only).

**Explicitly out of scope** (per ticket Non-goals — do not implement, even opportunistically):

- No `usage_events` row **insertion** anywhere in this ticket — `checkAndIncrementQuota` only reads/counts; it does not write. Row insertion is FND-10's `recordUsage()`.
- No `parse` quota key in `DAILY_QUOTA` — PARSE has no stated quota (PRD §8.3, `01-foundation/README.md`'s decisions table). Do not add one "for completeness."
- No per-route wiring (no edits to any `app/api/**` route) — that is each stage-owning ticket's own job (FIT-01, TLR-01, PRP-01), cited in their own Deliverables and confirmed by direct read in §0.
- No admin UI, no aggregation/reporting queries beyond the two functions named — `07-platform-launch`/PLT-03 imports this module's exports, does not get new exports from this ticket for that purpose.
- No edits to `db/schema.ts` or `lib/schemas/persisted.ts` — read/import only.
- No date-based automatic switching between `PRICING.sonnet5` and `PRICING.sonnet5PostIntro` — both rate sets are exposed; callers pick explicitly (ticket Feedback obligation #1 — flag to Horace before adding date-branching logic, do not silently add it here).
- No DB-level locking/atomicity fix for `checkAndIncrementQuota`'s "check before, record after" race — ticket Feedback obligation #2 explicitly accepts this race for v1 and asks for it to be documented in a code comment, not closed.

## 2. Change list

### 2.1 `lib/config/models.ts` (new file)

```ts
// PRD §8.1 model-pin policy: "模型 pin 在 config" — the model pin is a single
// named export, not a string literal scattered per route file. Every stage
// route (FIT-01/FIT-02, TLR-01, PRP-01/PRP-02) and the eval judge harness
// (EVL-02) import these constants; a model upgrade is a one-line diff here
// whose blast radius is exactly what PRD §6's Q1–Q3 quality gates exist to
// catch. No other file in the repo may hardcode either model name string
// (enforced by code-review convention — see the ticket's Deliverable 1 note;
// this file cannot enforce it mechanically across future tickets).

export const PRIMARY_MODEL = 'claude-sonnet-5';
export const JUDGE_MODEL = 'claude-haiku-4-5';
```

No additional exports (no derived union type, no default export) — the ticket asks for exactly these two named constants; keep the file minimal so its only job (being the one place these two strings live) stays obvious.

### 2.2 `lib/config/pricing.ts` (new file)

```ts
// PRD §9 raw unit prices (定价基准 2026-07 核对), quoted verbatim: "Sonnet 5 =
// $2 in / $10 out per MTok（8/31 前介绍价；之后 $3/$15…）；web search $10 /
// 1,000 次；Haiku 4.5（judge）$1/$5。" The intro-price / post-8-31-price
// distinction is carried as two named, independent rate sets — this module
// does NOT resolve which one is "current" based on today's date (that would be
// date-branching logic the ticket's Feedback obligation #1 explicitly asks to
// flag to Horace before adding, since PRD names an exact cutover date this
// ticket cannot resolve on 2026-07-18). Every caller of estimateCostUsd must
// pass `model` explicitly.
export const PRICING = {
  sonnet5: { inPerMTok: 2, outPerMTok: 10 },
  sonnet5PostIntro: { inPerMTok: 3, outPerMTok: 15 },
  haiku45: { inPerMTok: 1, outPerMTok: 5 },
  webSearchPer1000: 10,
} as const;

// The three rate-set keys in PRICING (excludes webSearchPer1000, which is a
// single shared per-1000-searches rate, not a per-model rate set). NOTE: these
// are PRICING-table keys, distinct from models.ts's PRIMARY_MODEL/JUDGE_MODEL
// string values ('claude-sonnet-5' / 'claude-haiku-4-5') — callers translate
// "which model did I call" to "which PRICING key applies" themselves; this
// module does not provide that translation (not requested by any Deliverable).
export type PricingModel = 'sonnet5' | 'sonnet5PostIntro' | 'haiku45';

/**
 * Pure function: computes actual cost in USD from real per-call token/search
 * counts, using the raw per-token/per-search rates above — NOT the rough
 * per-operation estimates in PRD §9's illustrative table (~$0.03/~$0.04/etc.),
 * which are only ballpark guidance, not something this function reproduces.
 * Used identically by FND-10's recordUsage() (real usage recording) and
 * (indirectly, via FND-10) by EVL-02 (judge-call cost tracking).
 */
export function estimateCostUsd(params: {
  model: PricingModel;
  tokensIn: number;
  tokensOut: number;
  searches: number;
}): number {
  const rate = PRICING[params.model];
  const tokenCostUsd =
    (params.tokensIn / 1_000_000) * rate.inPerMTok +
    (params.tokensOut / 1_000_000) * rate.outPerMTok;
  const searchCostUsd = (params.searches / 1_000) * PRICING.webSearchPer1000;
  return tokenCostUsd + searchCostUsd;
}
```

Notes:

- `searches` is a required `number` (not optional/defaulted) — matches `UsageEvent.searches: z.number()` (FND-04), which is always present, never optional. Every caller (FND-10, and EVL-02 indirectly) passes `0` explicitly for non-search stages (READ/CROSS/TAILOR/REHEARSE); only RESEARCH has a nonzero value.
- No rounding is applied to the returned `costUsd` — plain JS floating-point arithmetic, so values like `0.049999999999999996` instead of an exact `0.05` are possible. Not fixed here (the ticket specifies no rounding rule); flagged in §4.
- `PRICING` is `as const` so `PRICING.sonnet5.inPerMTok` etc. are literal-typed, not widened to `number` — this is what makes `estimateCostUsd`'s `rate` lookup type-safe without an explicit cast.

### 2.3 `lib/config/quota.ts` (new file) — the ticket's central design decision

```ts
import { and, count, eq, gte, sum } from 'drizzle-orm';

import { db } from '@/db/index';
import { usageEvents } from '@/db/schema';
import type { UsageOp } from '@/lib/schemas/persisted';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Start of "today" in UTC, as an epoch-ms number — matches usage_events'
// bigint(epoch-ms) createdAt column with zero conversion (PRD §8.1 "配额用
// Postgres 计数器"; the day boundary itself is not PRD-specified beyond
// "每日" — UTC is this ticket's choice, consistent with every other
// timestamp in the schema already being UTC-implicit epoch-ms with no
// timezone field anywhere in FND-02/03/04's schemas).
function startOfTodayUtcMs(nowMs: number = Date.now()): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// PRD §8.3: "配额：per-user 每日 10 fit / 5 tailor / 3 prep". Keyed by the
// three product-level quota buckets PRD names — NOT by UsageOp (see the
// mapping table below for why those are different vocabularies). No `parse`
// key: PARSE has no stated quota (01-foundation/README.md's decisions table)
// — do not add one here; a future PARSE quota is a PRD change, not a silent
// addition to this file.
export const DAILY_QUOTA = {
  fit: 10,
  tailor: 5,
  prep: 3,
} as const;

export type QuotaOp = keyof typeof DAILY_QUOTA; // 'fit' | 'tailor' | 'prep'

// --- Quota-bucket -> usage_events.op mapping -------------------------------
// DAILY_QUOTA's three keys are product-level "user-facing operation" names
// (PRD §8.3); usage_events.op is UsageOp, a pipeline-STAGE vocabulary (FND-04)
// with no 'fit'/'prep' values at all. Each quota bucket is charged exactly
// ONCE per user-facing action, at that action's FIRST internal call — the
// second internal call of the same action does NOT re-check quota (confirmed
// by direct read of the downstream tickets that implement this, since none of
// 03-library/04-fit/05-tailor/06-prep is built yet as of this plan):
//   fit    -> 'read'     FIT-01 charges `fit` quota once, before READ, and
//                        calls recordUsage(op:'read'). FIT-02's later
//                        recordUsage(op:'cross') does NOT re-check quota
//                        (FIT-02 ticket, Non-goals). Counting 'cross' here
//                        would double-count against 'read'.
//   tailor -> 'tailor'   TLR-01: 1:1 name match, single call, no ambiguity.
//   prep   -> 'research' PRP-01 charges `prep` quota once, before RESEARCH,
//                        and calls recordUsage(op:'research') on success.
//                        PRP-02's later recordUsage(op:'rehearse') does NOT
//                        re-check quota (PRP-02 ticket, Non-goals). Counting
//                        'rehearse' here would double-count against
//                        'research'.
//
// CROSS-TICKET COORDINATION RISK: this mapping is FND-06's own reading of
// FIT-01/TLR-01/PRP-01's ticket text as currently drafted — those tickets are
// not yet built. If any of their Builders implement a different op value for
// the FIRST recordUsage() call of their multi-call action, this mapping
// silently breaks (quota under- or over-counts) with no compile-time signal,
// since UsageOp's type alone cannot express "the first op of a given
// multi-call action". Each of FIT-01/TLR-01/PRP-01's own Architect pass MUST
// re-confirm this table against the actually-merged quota.ts before that
// ticket is built; if it needs to change, update this table AND this comment
// in the same commit, do not silently diverge (same escalation discipline as
// this ticket's own Feedback obligations).
const QUOTA_OP_TO_USAGE_OP: Record<QuotaOp, UsageOp> = {
  fit: 'read',
  tailor: 'tailor',
  prep: 'research',
};

/**
 * Checks (does NOT insert a row — see the file-level race-condition note
 * below) whether `userId` has remaining `op` quota for "today" (UTC).
 * Queries usage_events for COUNT(*) WHERE userId = ? AND op = <mapped op>
 * AND createdAt >= <start of today, UTC>, compares against DAILY_QUOTA[op].
 *
 * KNOWN RACE (ticket Feedback obligation #2, documented here per that
 * obligation's own instruction, not silently assumed): this function only
 * CHECKS; the stage route calls FND-10's recordUsage() separately, AFTER its
 * operation succeeds, to actually persist the counted row. Two concurrent
 * requests from the same user can both pass this check before either's
 * usage_events row exists, letting the user momentarily exceed quota by 1.
 * Accepted for v1: the per-user quota numbers are low enough (max 10/day)
 * that the financial exposure is negligible (worst case ~1 extra ~$0.10
 * call). If this acceptance is ever revisited (e.g. via a DB-level advisory
 * lock or an atomic check-and-increment), that is a deliberate hardening
 * decision requiring Horace's sign-off, not a silent fix.
 */
export async function checkAndIncrementQuota(
  userId: string,
  op: QuotaOp,
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const startOfDay = startOfTodayUtcMs();
  const usageOp = QUOTA_OP_TO_USAGE_OP[op];

  const [row] = await db
    .select({ used: count() })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.userId, userId),
        eq(usageEvents.op, usageOp),
        gte(usageEvents.createdAt, startOfDay),
      ),
    );

  const used = Number(row?.used ?? 0);
  const limit = DAILY_QUOTA[op];

  return {
    allowed: used < limit,
    remaining: Math.max(limit - used, 0),
    resetAt: startOfDay + ONE_DAY_MS,
  };
}

/**
 * Checks today's (UTC) total spend across ALL users against
 * process.env.GLOBAL_DAILY_SPEND_LIMIT_USD (PRD §8.3 "全局日花费熔断阈值
 * （env）"). Deliberately NOT userId-scoped — this is a single org-wide cap,
 * not a per-user check; do not add a userId filter here even by analogy with
 * checkAndIncrementQuota.
 *
 * Throws (does not return `tripped: false`) if the env var is unset, empty,
 * or not a finite number — an unset breaker threshold silently disabling the
 * breaker would itself be a cost-control regression (ticket Deliverable 3).
 * Note: `Number('')` is `0`, not `NaN`, in JS — an empty-string env var is
 * checked for explicitly below so it cannot be silently misread as "$0
 * limit" (which would trip on any spend) or bypass the throw.
 */
export async function checkGlobalBreaker(): Promise<{
  tripped: boolean;
  spentTodayUsd: number;
  limitUsd: number;
}> {
  const raw = process.env.GLOBAL_DAILY_SPEND_LIMIT_USD;
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(Number(raw))) {
    throw new Error(
      'GLOBAL_DAILY_SPEND_LIMIT_USD is not set (or not numeric). The global ' +
        'daily spend breaker cannot run without it — set it in your ' +
        'environment (see .env.example) before calling checkGlobalBreaker().',
    );
  }
  const limitUsd = Number(raw);

  const startOfDay = startOfTodayUtcMs();
  const [row] = await db
    .select({ total: sum(usageEvents.costUsd) })
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, startOfDay));

  const spentTodayUsd = Number(row?.total ?? 0);

  return {
    tripped: spentTodayUsd >= limitUsd,
    spentTodayUsd,
    limitUsd,
  };
}
```

Implementation notes for the Builder:

- `count()`/`sum()` come from `drizzle-orm`'s aggregate helpers (confirmed present in the installed `drizzle-orm` version — `node_modules/drizzle-orm/sql/functions/aggregate.d.ts`). `count()`'s TS type is `SQL<number>`; `sum()`'s is `SQL<string | null>` (SQL `SUM` over a `numeric` column returns text to avoid precision loss, and returns `NULL` — one row, `total: null` — when zero rows match, not zero rows). Both code paths above already defensively `Number(...)`-coerce and null-coalesce; verify empirically once tests run (§3) that no further conversion is needed, same "verify against the installed version" discipline FND-05's plan used for `numeric(mode:'number')`.
- `and`/`eq`/`gte` are also standard `drizzle-orm` exports, already used implicitly by this repo's schema/index files' typings; no new import surface risk.
- `usageEvents.op`'s Drizzle column type (from the `usageOpEnum` pg enum) and `UsageOp`'s Zod-inferred type are structurally identical literal unions — `QUOTA_OP_TO_USAGE_OP`'s values type-check against both without a cast.
- `checkAndIncrementQuota`'s name is inherited verbatim from the ticket's own Deliverable 3 text despite not literally incrementing anything — do not "fix" the name to `checkQuota` or similar; it is intentionally named to signal the *intended* check-and-increment semantic even though the increment is deliberately deferred to FND-10 (see the KNOWN RACE comment above, which exists precisely to explain this naming/behavior gap).
- `QUOTA_OP_TO_USAGE_OP` is **not exported** — it is an internal implementation detail of the counting mechanism, not part of this ticket's Deliverable 3 export list (`DAILY_QUOTA`, `checkAndIncrementQuota`, `checkGlobalBreaker`). Keep the module's public surface exactly as specified; do not add unrequested exports that downstream tickets might start depending on.

### 2.4 `lib/config/pricing.test.ts` (new file)

Vitest unit tests, pure functions, no DB/env dependency:

1. `estimateCostUsd({ model: 'sonnet5', tokensIn: 100_000, tokensOut: 20_000, searches: 0 })` equals `0.4` exactly — hand-verified: `100,000/1,000,000 * 2 = 0.2` (input) + `20,000/1,000,000 * 10 = 0.2` (output) = `0.4`. This is the ticket's own literal example (acceptance-checklist item 1).
2. A second case with `searches > 0` (e.g. `searches: 3` on top of case 1's token counts) asserts the search cost is additive: `+ (3/1000 * 10) = +0.03`, total `0.43`.
3. `estimateCostUsd({ model: 'sonnet5PostIntro', ... })` with the same token counts as case 1 produces a **different** (higher) result than case 1 — proves the two Sonnet rate sets are genuinely distinct, not aliased to the same numbers by a copy-paste error.
4. `estimateCostUsd({ model: 'haiku45', ... })` uses the Haiku rates ($1 in / $5 out) — one more hand-verified arithmetic case.
5. Direct transcription check on `PRICING` itself (catches a typo independent of `estimateCostUsd`'s arithmetic being separately correct): `expect(PRICING).toEqual({ sonnet5: { inPerMTok: 2, outPerMTok: 10 }, sonnet5PostIntro: { inPerMTok: 3, outPerMTok: 15 }, haiku45: { inPerMTok: 1, outPerMTok: 5 }, webSearchPer1000: 10 })`.
6. `estimateCostUsd({ model: 'sonnet5', tokensIn: 0, tokensOut: 0, searches: 0 })` equals `0` — trivial zero-input boundary case.

### 2.5 `lib/config/quota.test.ts` (new file) — PGlite-mocked `@/db/index`, per-suite isolation

This is the more involved test file. `lib/config/quota.ts` imports the real `db` from `@/db/index`, which throws at import time without `DATABASE_URL`. Tests must never let that real module load; instead they swap in a PGlite-backed Drizzle client via `vi.doMock('@/db/index', ...)` + `vi.resetModules()` + dynamic `import()` of `@/lib/config/quota` — the same "reset the module registry so the top-level import-time code re-runs" pattern already established by `db/index.test.ts` (FND-05), extended here to swap the *implementation*, not just the env var.

Two isolation strategies, chosen per describe block based on whether the function under test is user-scoped:

**`checkAndIncrementQuota` describe block** — one shared PGlite instance for the whole block (`beforeAll`), migrated once via `drizzle-orm/pglite/migrator`'s `migrate()` against the real committed `db/migrations/**`. Every `it()` uses a **fresh, random `userId`** (`crypto.randomUUID()`) plus a corresponding seeded `users` row (required by the `usage_events.userId` FK) — since the function's own query is already `userId`-scoped, distinct random user IDs give full test-to-test isolation without needing to truncate tables between tests.

**`checkGlobalBreaker` describe block** — a **fresh PGlite instance per `it()`** (`beforeEach`), since this function sums `costUsd` across *all* users with no `userId` filter; sharing one instance across tests in this block would let one test's seeded spend leak into another's `spentTodayUsd` assertion.

```ts
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';

async function createTestDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './db/migrations' });
  return db;
}

async function seedUser(db: Awaited<ReturnType<typeof createTestDb>>, userId: string) {
  await db.insert(schema.users).values({ id: userId, email: `${userId}@example.com` });
}

// Inserts one usage_events row for userId/op at `createdAt` (defaults to now).
async function seedUsageEvent(
  db: Awaited<ReturnType<typeof createTestDb>>,
  opts: { userId: string; op: schema.usageOpEnum.enumValues[number]; createdAt: number; costUsd?: number },
) {
  await db.insert(schema.usageEvents).values({
    userId: opts.userId,
    op: opts.op,
    tokensIn: 100,
    tokensOut: 100,
    searches: 0,
    costUsd: opts.costUsd ?? 0.01,
    durationMs: 1000,
    createdAt: opts.createdAt,
  });
}

describe('checkAndIncrementQuota', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    db = await createTestDb();
    vi.resetModules();
    vi.doMock('@/db/index', () => ({ db }));
  });

  // ... it() cases, each with its own crypto.randomUUID() userId, calling
  // `const { checkAndIncrementQuota } = await import('@/lib/config/quota');`
});

describe('checkGlobalBreaker', () => {
  const ORIGINAL_LIMIT = process.env.GLOBAL_DAILY_SPEND_LIMIT_USD;

  beforeEach(async () => {
    const db = await createTestDb();
    vi.resetModules();
    vi.doMock('@/db/index', () => ({ db }));
  });

  afterEach(() => {
    if (ORIGINAL_LIMIT === undefined) delete process.env.GLOBAL_DAILY_SPEND_LIMIT_USD;
    else process.env.GLOBAL_DAILY_SPEND_LIMIT_USD = ORIGINAL_LIMIT;
  });

  // ... it() cases
});
```

(`schema.usageOpEnum.enumValues[number]` above is illustrative typing shorthand for "one of the six `UsageOp` literal strings" — use whatever concrete type the Builder finds cleanest; the point is the helper accepts any valid `op` string, not just the three quota-bucket names.)

Concrete `it()` cases required (mapping to the ticket's acceptance checklist plus supplementary coverage this plan recommends for the mapping table in §2.3, which nothing in the literal acceptance checklist directly exercises):

*`checkAndIncrementQuota`:*

1. **[acceptance item 2]** Seed exactly `DAILY_QUOTA.tailor` (5) `usage_events` rows with `op: 'tailor'`, today's timestamp, for a fresh `userId`. `checkAndIncrementQuota(userId, 'tailor')` → `allowed: false`, `remaining: 0`.
2. **[acceptance item 2]** Same setup with one fewer row (4) → `allowed: true`, `remaining: 1`.
3. **[acceptance item 3]** Seed `DAILY_QUOTA.tailor` (5) rows with `op: 'tailor'` but `createdAt` timestamped **yesterday** (`startOfTodayUtcMs() - 1` or earlier, computed the same way the production code does, imported or duplicated in the test) for a fresh `userId`. `checkAndIncrementQuota(userId, 'tailor')` → `allowed: true`, `remaining: 5` (none of yesterday's rows count).
4. `resetAt` equals `startOfTodayUtcMs() + ONE_DAY_MS` (start of tomorrow, UTC) — assert directly against a locally recomputed boundary, not a hardcoded literal, to avoid a flaky test around real-world midnight UTC.
5. **[supplementary, proves the §2.3 mapping table, not in the literal acceptance checklist]** For a fresh `userId`, seed **one** `op: 'read'` row and **one** `op: 'cross'` row (both today) — simulating one completed Fit action (FIT-01's `'read'` write + FIT-02's later `'cross'` write). `checkAndIncrementQuota(userId, 'fit')` must report `used` = 1 action, i.e. `remaining: DAILY_QUOTA.fit - 1` (= 9), **not** `DAILY_QUOTA.fit - 2` — proving the count is keyed on `'read'` only and does not double-count `'cross'`.
6. **[supplementary, same rationale as case 5]** For a fresh `userId`, seed one `op: 'research'` row and one `op: 'rehearse'` row (both today) — simulating one completed Prep action. `checkAndIncrementQuota(userId, 'prep')` → `remaining: DAILY_QUOTA.prep - 1` (= 2), not `DAILY_QUOTA.prep - 2`.
7. A `userId` with zero seeded rows for any op → `allowed: true`, `remaining: DAILY_QUOTA[op]` for each of `'fit'`/`'tailor'`/`'prep'` — baseline/empty-state case.

*`checkGlobalBreaker`:*

8. **[acceptance item 4]** `delete process.env.GLOBAL_DAILY_SPEND_LIMIT_USD` before the call → `await expect(checkGlobalBreaker()).rejects.toThrow(/GLOBAL_DAILY_SPEND_LIMIT_USD/)`.
9. **[supplementary — Deliverable 3's "or non-numeric" clause]** `process.env.GLOBAL_DAILY_SPEND_LIMIT_USD = 'not-a-number'` → same rejects/toThrow assertion.
10. **[supplementary — the `Number('') === 0` pitfall named in §2.3's code comment]** `process.env.GLOBAL_DAILY_SPEND_LIMIT_USD = ''` (set to an empty string, not deleted) → still throws (proves the explicit `.trim() === ''` guard is load-bearing, not redundant with the `Number.isFinite` check alone).
11. Set the limit to `'10'`; seed two `usage_events` rows today (different users, e.g. `costUsd: 2` and `costUsd: 3`) → `checkGlobalBreaker()` → `{ tripped: false, spentTodayUsd: 5, limitUsd: 10 }`.
12. Set the limit to `'5'`; seed rows summing to exactly `5` today → `tripped: true` (boundary is inclusive, `>=`, per §2.3's implementation).
13. Set the limit to `'1000000'`; seed one large-`costUsd` row timestamped **yesterday** and no rows today → `spentTodayUsd: 0`, `tripped: false` — proves the day-window filter applies to the breaker too, not just to per-user quota.
14. Zero `usage_events` rows at all (fresh PGlite, freshly migrated, nothing inserted) with any valid numeric limit → `spentTodayUsd: 0` (proves the `sum()` → `NULL` → `Number(null ?? 0)` path is handled, not a crash or `NaN`).

*`DAILY_QUOTA` (can live in either test file; this plan puts it in `quota.test.ts` since it's colocated with the constant's own module):*

15. **[acceptance item 5]** `expect(DAILY_QUOTA).not.toHaveProperty('parse')`.
16. Direct transcription check: `expect(DAILY_QUOTA).toEqual({ fit: 10, tailor: 5, prep: 3 })`.

### 2.6 `.env.example` (append-only)

Append one line after the existing seven:

```
GLOBAL_DAILY_SPEND_LIMIT_USD=
```

No comment, no blank-line separation — matches the file's existing plain, uncommented style exactly (verified in §0). This is the second append to this file (FND-05 verified `DATABASE_URL` was already present and made no edit; this ticket is the first actual append since FND-01 created it) — per the ticket's own File-scope note, sequential, no in-flight contention.

## 3. Test plan

Maps to the ticket's acceptance checklist; each item is what the Builder/Reviewer actually runs.

1. `lib/config/pricing.test.ts` (§2.4) proves acceptance item 1 (`estimateCostUsd` hand-verified arithmetic against `PRICING.sonnet5`) plus the supplementary rate-set-distinctness and `PRICING` transcription checks.
2. `lib/config/quota.test.ts` cases 1–2 (§2.5) prove acceptance item 2 (`allowed:false` at the cap, `allowed:true` one under).
3. `lib/config/quota.test.ts` case 3 proves acceptance item 3 (yesterday's rows don't count).
4. `lib/config/quota.test.ts` cases 8–10 prove acceptance item 4 (`checkGlobalBreaker` throws on unset/non-numeric/empty-string env, never silently returns `tripped: false`).
5. `lib/config/quota.test.ts` case 15 proves acceptance item 5 (`DAILY_QUOTA` has no `parse` key) — a TS-level check is also available for free, since `QuotaOp = keyof typeof DAILY_QUOTA` structurally excludes `'parse'` from `checkAndIncrementQuota`'s second parameter; the runtime `not.toHaveProperty` assertion is still required since the acceptance checklist names it explicitly as a machine check.
6. `lib/config/quota.test.ts` cases 5–6 and 11–14 are supplementary coverage this plan adds beyond the literal acceptance checklist, specifically to protect the §2.3 mapping table (the highest-risk, most novel part of this ticket's design) and the `sum()`-returns-`NULL`-on-zero-rows edge case.
7. `pnpm test` exits 0 overall (acceptance item 6), including every pre-existing suite (`tests/**`, `lib/**` from FND-02/03/04, `db/**` from FND-05) unaffected, plus the two new `lib/config/*.test.ts` files actually discovered (already covered by `vitest.config.ts`'s existing `lib/**/*.test.ts` glob per §0 — explicitly check the test-run output lists the two new files, don't just check the exit code, per this repo's established "don't let a glob miss create a false green" discipline from FND-02/FND-05's own plans).
8. `pnpm exec tsc --noEmit` (or `pnpm build`) once, after all four production files are complete — cheap insurance beyond Vitest's non-typechecking esbuild transpile, particularly relevant here given `QUOTA_OP_TO_USAGE_OP`'s `Record<QuotaOp, UsageOp>` typing and `PRICING`'s `as const` usage, which a type error could hide from Vitest but not from `tsc`.
9. `git diff --stat a807f81..HEAD` (base commit confirmed in §0) should list exactly: `lib/config/models.ts`, `lib/config/pricing.ts`, `lib/config/pricing.test.ts`, `lib/config/quota.ts`, `lib/config/quota.test.ts`, `.env.example`. Anything else (in particular any edit inside `db/schema.ts`, `lib/schemas/**`, `vitest.config.ts`, or `package.json`) is a File-scope violation and must be reverted before merge — this ticket needs none of those writebacks (unlike FND-02/FND-05, confirmed in §0).
10. Everything above is reproducible fully offline (no live `DATABASE_URL`, no live `GLOBAL_DAILY_SPEND_LIMIT_USD`, no real Anthropic API calls) — `checkGlobalBreaker`'s and `checkAndIncrementQuota`'s tests exercise `@/db/index` only via the PGlite mock (§2.5), never the real module.

## 4. Risks & edge cases

- **Concurrency (explicitly in scope for the Reviewer per this repo's `CLAUDE.md`: "Focus: edge cases, concurrency").** `checkAndIncrementQuota`'s "check before, record after" split is a known, ticket-accepted race under concurrent requests from the same user — documented in a code comment on the function itself (§2.3) per the ticket's Feedback obligation #2, not silently assumed. This plan does not add any locking/atomicity mechanism; if the Reviewer disagrees with accepting this race, the ticket's own instruction is to escalate to Horace rather than silently harden it (e.g. via a DB advisory lock) without a decision record. `checkGlobalBreaker` has an analogous, even lower-stakes point-in-time-check race (spend can tip over the limit between the check and the caller's subsequent LLM call) — this is accepted by the same product-level reasoning and is why FIT-02/PRP-02's own tickets re-call `checkGlobalBreaker()` immediately before their own paid calls rather than trusting an earlier check (confirmed by direct read in §0's citations) — no new mitigation needed from this ticket.
- **Security-sensitive path: `checkAndIncrementQuota(userId, op)` trusts its caller for `userId`'s authenticity — it performs no authentication itself.** Its own query is correctly scoped (`WHERE userId = ?`), so it does not itself introduce a cross-user leak, but nothing in this function stops a caller from passing an arbitrary/spoofed `userId` string. That trust boundary is FND-08's job (`requireUserId()` deriving `userId` from a verified session) — every call site (FIT-01, TLR-01, PRP-01) is expected to pass a session-derived `userId`, never a client-supplied one. Flagged explicitly per PRD §8.3's "无跨用户查询路径" mandate and this repo's established FND-05 precedent of naming this same trust boundary in its own plan.
- **`checkGlobalBreaker` is deliberately NOT `userId`-scoped** — a single org-wide daily cap, by design (PRD §8.3: "全局日花费熔断阈值"). Flagged explicitly so this isn't mistaken by a Reviewer for a missing isolation filter; it is the one function in this ticket that is correctly global.
- **Cross-ticket coordination risk on the `fit`/`prep` → `UsageOp` mapping (§2.3)**, the single highest-risk design decision in this ticket. The mapping is sourced from FIT-01/TLR-01/PRP-01's *current* ticket text, none of which is built yet (`03-library`/`04-fit`/`05-tailor`/`06-prep` modules have no merged code). If any of those tickets' eventual implementation departs from the op value this plan assumes for the *first* call of its multi-call action, `checkAndIncrementQuota` will silently under- or over-count that bucket's quota with no compile-time or (likely) test-time signal from *this* ticket's own suite — a regression would only surface once that downstream ticket is actually built and its own tests exercise the real end-to-end flow. Mitigations already in place: (a) the mapping is documented in an in-code comment with citations (§2.3) so a future Reader/Reviewer can re-verify it against the cited ticket lines directly; (b) §2.5's supplementary test cases 5–6 prove the *mechanism* (no double-counting between an action's two recorded ops) works correctly for whatever mapping is configured, so if the mapping itself changes later, only the one-line `QUOTA_OP_TO_USAGE_OP` table needs updating, not the counting logic. No further mitigation is proposed here — full closure would require either building FIT-01/TLR-01/PRP-01 first (not this ticket's order in the dependency graph) or a shared enum unifying quota-bucket and usage-op vocabularies (a bigger, unrequested redesign).
- **`Number('') === 0` in JavaScript** — an empty (but *set*) `GLOBAL_DAILY_SPEND_LIMIT_USD=""` could otherwise silently be read as a valid `$0` limit (tripping the breaker on any spend at all) or, worse, bypass a naive `!raw` falsy check inconsistently. §2.3's implementation explicitly guards `raw.trim() === ''` before the numeric check; §2.5 case 10 tests this specifically. A `GLOBAL_DAILY_SPEND_LIMIT_USD=0` (a genuinely configured zero limit, not empty) is intentionally treated as *valid* (not an error) — `Number('0')` is `0`, `Number.isFinite(0)` is `true` — since a deliberately-set $0 cap is a legitimate (if extreme) admin choice, distinct from an unset/misconfigured one.
- **`sum(usageEvents.costUsd)` returns `SQL<string | null>` at the type level, and Postgres `SUM` over zero rows returns one row with `NULL`, not zero rows.** §2.3's `Number(row?.total ?? 0)` and §2.5 case 14 both specifically cover this — a naive implementation that skipped the null-coalesce would produce `NaN` on a day with zero usage events, silently breaking `tripped: NaN >= limit` (always `false`, masking a bug rather than crashing loudly — worth calling out precisely because it fails *quietly*, not loudly, unlike most of this ticket's other guarded edge cases).
- **No rounding on `estimateCostUsd`'s return value** — plain floating-point arithmetic can produce values with trailing precision noise (e.g. `0.30000000000000004`). Not addressed here since the ticket specifies no rounding rule; if `numeric(cost_usd)`'s Postgres column or a future admin-UI display ever needs cent-level precision, that is a follow-up ticket's decision, not this one's to silently guess.
- **The Sonnet 5 intro/post-8-31 price cutover is unresolved by design** (ticket Feedback obligation #1) — after 2026-08-31, any caller still passing `model: 'sonnet5'` (rather than `'sonnet5PostIntro'`) will under-report actual cost by 50%. This is an operational risk for Horace/FND-10's callers to track, not something `estimateCostUsd` can catch on its own, since the function is deliberately calendar-unaware.
- **Windows/cross-platform**: this plan reuses FND-05's already-proven-cross-platform PGlite + `drizzle-orm/pglite` test infrastructure (confirmed working via `db/migrate.test.ts` on this same Windows dev machine, per FND-05's plan §4) — no new platform-specific risk introduced by this ticket's own test files.

## 5. Open questions

| # | Question | Who decides |
|---|---|---|
| 1 | Whether the `fit -> 'read'`, `tailor -> 'tailor'`, `prep -> 'research'` mapping (§2.3, sourced from FIT-01/TLR-01/PRP-01's current ticket text) still holds once those tickets are actually built. | Each of FIT-01/TLR-01/PRP-01's own Architect pass, at that ticket's planning time — re-verify against the merged `lib/config/quota.ts` before building; update the mapping table + comment in the same commit if it has drifted, per this ticket's own escalation discipline. |
| 2 | Whether `lib/config/models.ts` should get its own trivial `models.test.ts` even though the ticket's File-scope names only `quota.test.ts`/`pricing.test.ts`. This plan's default: no, since the two named constants have no logic to test beyond "does this string literal match PRD §8.1," which a code-review read already covers, and adding an unrequested test file is a minor File-scope deviation. | Builder, at build time (low-stakes either way) — Reviewer may also flag it. |
| 3 | Whether the Sonnet 5 intro/post-8-31 price cutover should eventually be automated (date-based) rather than left as two named rate sets requiring an explicit caller choice. | Horace — ticket Feedback obligation #1 explicitly defers this; do not resolve it in this ticket. |
| 4 | Whether `checkAndIncrementQuota`'s accepted "check before, record after" race (§4) remains acceptable once real usage data exists, or should be hardened (e.g. DB advisory lock). | Horace — ticket Feedback obligation #2's default is "accepted for v1"; escalate rather than silently hardening. |
| 5 | Whether `estimateCostUsd`'s unrounded return value ever needs a fixed-precision rounding rule (e.g. for admin-UI display or exact-cent accounting). | Reviewer/Horace, if/when this becomes a real observed issue (e.g. via `07-platform-launch`/PLT-03's admin cost summary) — not resolved here since the ticket specifies no rounding instruction. |

## 6. ADR-candidate flag

**Not proposing a new ADR.** The ticket is explicit that none is needed for the core model-pin/pricing/quota-numbers decisions (already made in PRD §8.1/§9/§8.3). The one genuinely architectural decision this ticket's design touches — "a multi-call user-facing action (Fit's READ+CROSS, Prep's RESEARCH+REHEARSE) is charged exactly one quota unit, at its first call" — is **already** flagged as a pre-existing ADR-0001 candidate by both `04-fit/README.md` and `06-prep/README.md` (both citing `docs/prd/breakdown-plan.md` §6 open question #8), independent of this ticket. This plan's own contribution (§2.3's `QUOTA_OP_TO_USAGE_OP` table) is purely an *implementation mechanism* for counting against that already-decided policy — a one-line, easily-reversed mapping table, not a new hard-to-reverse choice — so it does not itself rise to a new ADR-candidate flag beyond noting (§4, §5 item 1) that it is currently unverified against not-yet-built downstream tickets and should be re-confirmed when they are built.
