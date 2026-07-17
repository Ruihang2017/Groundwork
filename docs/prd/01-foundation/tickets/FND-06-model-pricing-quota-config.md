---
id: FND-06
title: Model, pricing, and quota configuration
module: 01-foundation
lane: 01-foundation
size: M
agent: builder
status: draft
date: 2026-07-17
blocked_by: [FND-01, FND-05]
blocks: [FND-10, EVL-02, LIB-01, FIT-01, TLR-01, PRP-01]
---

# FND-06 — Model, pricing, and quota configuration

No ADR — the decision is already made in PRD §8.1 (model pin policy), §9 (pricing table), §8.3 (quota numbers); this is build ticket 6 of 10 against the `01-foundation` module.
Parent sub-PRD: [01-foundation README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [FND-01 — Repo and toolchain bootstrap](FND-01-repo-toolchain-bootstrap.md), [FND-05 — Drizzle schema, Neon Postgres client, and migrations](FND-05-drizzle-schema-neon.md)
**Why `builder`:** transcribing pinned numbers from PRD §8.1/§9/§8.3 into a single config module, plus writing the counter/breaker query functions against FND-05's already-decided `usage_events` schema — no new design.

## Background + basis

PRD §8.1: "**模型 pin 在 config**——v1 基线 `claude-sonnet-5`，judge `claude-haiku-4-5`。任何升级必须先全量通过 Q1–Q3 再切；这条政策本身就是 Q1–Q3 存在的理由之一。" This is why the model pin must be a single named export, not scattered string literals per route file — every stage route and the judge harness import the same constant, so an upgrade is a one-line diff whose blast radius is exactly what Q1–Q3 exist to catch.

PRD §9 pricing table (定价基准 2026-07 核对，quoted verbatim):

| 操作 | 主要调用 | 估算成本 |
|---|---|---|
| 建库 PARSE | 1 次（PDF document input） | ~$0.03 |
| Fit | READ + CROSS（SCORE 为代码，免费） | ~$0.04（$0.06） |
| Tailor | 1 次长输出 | ~$0.05（$0.07） |
| Prep | RESEARCH（含 2–4 次搜索）+ REHEARSE | ~$0.08–0.10（$0.13） |

Raw unit prices, same section: "Sonnet 5 = $2 in / $10 out per MTok（8/31 前介绍价；之后 $3/$15…）；web search $10 / 1,000 次；Haiku 4.5（judge）$1/$5。" These per-token/per-search rates — not the rough per-operation estimates above — are what the cost-estimator function in this ticket must compute from actual `tokensIn`/`tokensOut`/`searches`, since actual costs vary per call and the table above is only an illustrative estimate.

PRD §8.3: "配额：per-user 每日 10 fit / 5 tailor / 3 prep；全局日花费熔断阈值（env）；Anthropic Console 月度预算告警。" — three named quota buckets only (`fit`, `tailor`, `prep`); PARSE has no stated quota (per `01-foundation/README.md`'s decisions table — do not invent one).

PRD §8.1: "配额用 Postgres 计数器" — this ticket's quota/breaker functions must query `usage_events` (FND-05) directly, not maintain a separate counter table.

## Goal

`lib/config/models.ts` (model pin constants), `lib/config/pricing.ts` (rate table + cost estimator function), `lib/config/quota.ts` (daily quota numbers + `checkAndIncrementQuota()` + `checkGlobalBreaker()` functions backed by `usage_events` queries).

## Non-goals

- No actual `usage_events` row insertion — that's FND-10 (this ticket only *reads* `usage_events` for quota/breaker checks; FND-10 *writes* it after an operation completes).
- No PARSE quota — explicitly excluded per Background and `01-foundation/README.md`'s decisions table; if a future ticket needs one, that is a PRD change, not a silent addition here.
- No per-route wiring (calling `checkAndIncrementQuota()` before an LLM call) — that is each stage-owning ticket's own responsibility (FIT-01 for `fit`, TLR-01 for `tailor`, PRP-01 for `prep`), cited explicitly in their own Deliverables.
- No admin UI reading these numbers — `07-platform-launch`/PLT-03 imports this module's exports, does not duplicate the numbers.

## File-scope (write-owns)

- `lib/config/models.ts`, `lib/config/pricing.ts`, `lib/config/quota.ts`
- `lib/config/quota.test.ts`, `lib/config/pricing.test.ts`
- `.env.example` — append `GLOBAL_DAILY_SPEND_LIMIT_USD` placeholder (PRD §8.3 "全局日花费熔断阈值（env）") — append-only, FND-01 owns the file's creation.
- Does not touch: `db/schema.ts` (FND-05, read/import the `usage_events` Drizzle table only, no schema edits), `lib/usage/record.ts` (FND-10).
- Serial-safety: FND-01/05 merged before this ticket starts; `.env.example`'s append here is the second/third touch after FND-01 (create) and FND-05 (append `DATABASE_URL`) — sequential, no in-flight contention.

## Deliverables

1. `lib/config/models.ts` exporting `PRIMARY_MODEL = 'claude-sonnet-5'` and `JUDGE_MODEL = 'claude-haiku-4-5'` as the single source every stage route and the eval harness import — no other file in the repo may hardcode either model name string (enforce via code review convention, noted here for the Reviewer stage's benefit even though this ticket cannot enforce it mechanically across future tickets).
2. `lib/config/pricing.ts` exporting:
   - `PRICING = { sonnet5: { inPerMTok: 2, outPerMTok: 10 }, sonnet5PostIntro: { inPerMTok: 3, outPerMTok: 15 }, haiku45: { inPerMTok: 1, outPerMTok: 5 }, webSearchPer1000: 10 }` (the raw rates from Background; the intro-price/post-8-31 distinction is carried as two named rate sets, not resolved by this ticket — callers pick which is current, e.g. via a date check or a manual config flip, since PRD names an exact cutover date "8/31" that is a future calendar event this ticket cannot resolve on 2026-07-17).
   - `estimateCostUsd({ model, tokensIn, tokensOut, searches }): number` — a pure function computing `costUsd` from the rate table above, used identically by FND-10 (real usage recording) and `02-evaluation`/EVL-02 (judge-call cost tracking).
3. `lib/config/quota.ts` exporting:
   - `DAILY_QUOTA = { fit: 10, tailor: 5, prep: 3 }` (PRD §8.3 numbers, keyed by the three `UsageOp` values that have a quota — `parse`/`research`/`rehearse` have no direct entry here; see Deliverable 4 for how `research`+`rehearse` map to the `prep` bucket).
   - `checkAndIncrementQuota(userId: string, op: 'fit' | 'tailor' | 'prep'): Promise<{ allowed: boolean; remaining: number; resetAt: number }>` — queries `usage_events` for `COUNT(*) WHERE userId = ? AND op = ? AND createdAt >= <start of today, UTC> `, compares against `DAILY_QUOTA[op]`. Does NOT insert a row itself (that remains FND-10's job, called by the stage route after the operation succeeds) — this function only *checks*, matching the "check before call, record after call" pattern each stage route follows.
   - `checkGlobalBreaker(): Promise<{ tripped: boolean; spentTodayUsd: number; limitUsd: number }>` — queries `SUM(costUsd) FROM usage_events WHERE createdAt >= <start of today, UTC>`, compares against `process.env.GLOBAL_DAILY_SPEND_LIMIT_USD` (parsed as a number; throws a clear error at call time if the env var is unset or non-numeric — fail loud, since an unset breaker threshold silently disabling the breaker would be a cost-control regression).
4. Document, in a code comment on `DAILY_QUOTA`, the mapping decision for the `prep` op bucket: PRD §8.3 names one `prep` quota bucket (3/day) but PRD §5.6's `UsageOp` (FND-04, Deliverable 5) has separate `research`/`rehearse` op values for `usage_events` recording granularity — `checkAndIncrementQuota('prep', ...)` is checked/incremented exactly once per Prep operation (at the start of `06-prep`/PRP-01's RESEARCH call, per that module's own decision, cited there), and covers both the RESEARCH and REHEARSE calls that follow within the same user-facing "生成简报" action.

## Acceptance checklist (classified)

- [ ] `[machine]` `estimateCostUsd` computes the correct value for a hand-picked `(tokensIn, tokensOut)` pair against `PRICING.sonnet5`, verified by manual arithmetic in the test (e.g. 100,000 in-tokens + 20,000 out-tokens at sonnet5 rates).
- [ ] `[machine]` `checkAndIncrementQuota` returns `allowed: false` once a mocked/test `usage_events` table already has `DAILY_QUOTA[op]` rows for that user+op+today, and `allowed: true` with one fewer.
- [ ] `[machine]` `checkAndIncrementQuota` does not count rows from a previous UTC day (test with a row timestamped yesterday — must not count toward today's quota).
- [ ] `[machine]` `checkGlobalBreaker` throws a clear error if `GLOBAL_DAILY_SPEND_LIMIT_USD` is unset (test asserts the throw, not a silent `tripped: false`).
- [ ] `[machine]` `DAILY_QUOTA` has no `parse` key (asserted via `expect(DAILY_QUOTA).not.toHaveProperty('parse')` or a TS-level type check) — encodes the Background decision that PARSE has no quota.
- [ ] `[machine]` `pnpm test` green.

## Test plan

Vitest unit/integration tests in `lib/config/quota.test.ts` and `lib/config/pricing.test.ts`. `checkAndIncrementQuota`/`checkGlobalBreaker` need a `usage_events`-shaped data source — use the same local/in-memory Postgres substitute decided in FND-05's Test plan (or, if that ticket recorded a Deviation falling back to mocked Drizzle queries, follow the same fallback here for consistency) seeded with rows at known timestamps (today vs. yesterday, at/under/over the quota threshold) to exercise the boundary conditions listed in the acceptance checklist.

## Feedback obligation

1. If the sonnet5 intro-price/post-8-31-price cutover needs to be resolved automatically (date-based) rather than left as two named rate sets, that is a policy decision beyond what PRD §9 specifies mechanically (PRD gives the date but not an automation instruction) — flag to Horace before adding date-branching logic; until resolved, `estimateCostUsd` callers must explicitly pass which rate set, and this ticket does not default to one silently.
2. If `checkAndIncrementQuota`'s "check before, record after" split (rather than an atomic check-and-increment) is found to allow a race under concurrent requests from the same user (two simultaneous Tailor calls both passing the check before either's `usage_events` row is written), that is a concurrency edge case explicitly in scope for the Reviewer stage to check (per this repo's `CLAUDE.md`: "Focus: edge cases, concurrency"). Document this known race explicitly in a code comment on `checkAndIncrementQuota` rather than silently assuming single-request-at-a-time — PRD does not specify a concurrency requirement here, so this ticket's default is "accepted for v1: a user could momentarily exceed quota by 1 under concurrent requests — documented, not enforced, per the low per-user quota numbers making the financial exposure negligible (worst case 1 extra ~$0.10 call)." If Horace disagrees with this acceptance, escalate rather than silently hardening it (e.g. via a DB-level advisory lock) without a decision record.
