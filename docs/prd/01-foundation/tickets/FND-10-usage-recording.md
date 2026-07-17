---
id: FND-10
title: Usage and cost observability recording helper
module: 01-foundation
lane: 01-foundation
size: S
agent: builder
status: draft
date: 2026-07-17
blocked_by: [FND-05, FND-06]
blocks: [LIB-01, FIT-01, TLR-01, PRP-01, PLT-03]
---

# FND-10 — Usage and cost observability recording helper

No ADR — the decision is already made in PRD §5.6 (`UsageEvent` schema) and §8.4 (observability policy); this is build ticket 10 of 10 against the `01-foundation` module.
Parent sub-PRD: [01-foundation README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [FND-05 — Drizzle schema, Neon Postgres client, and migrations](FND-05-drizzle-schema-neon.md), [FND-06 — Model, pricing, and quota configuration](FND-06-model-pricing-quota-config.md)
**Why `builder`:** a thin write-path wrapper composing FND-05's DB client and FND-06's cost estimator — no new design.

## Background + basis

PRD §5.6: "记账：成本与延迟从第一天可观测" and the `UsageEvent` shape (already realized as a Zod schema in FND-04). PRD §8.4: "每次操作落 tokens / searches / cost / duration / dropped / stage 状态；`/admin` 页汇总周成本、p50/p95、dropped 率、漏斗转化。不上 APM——一张表加一页汇总就是这个量级 observability 的全部。" — "dropped" and "stage 状态" are explicitly named as things "每次操作" must log, alongside tokens/searches/cost/duration — this means the `usage_events` row this ticket writes must be able to carry a dropped-count and a success/failure status, even though FND-04's `UsageEvent` Zod schema (transcribed strictly from PRD §5.6's code sketch) does not have those fields. This is a genuine gap between §5.6's code sketch and §8.4's prose requirement — resolved here per this ticket's own decision (see Deliverable 1) rather than silently picking one PRD section over the other.

PRD §9: "成本结构与漏斗形状一致（P4）：高频的筛最便宜，最贵的 prep 只发生在拿到面邀之后。" — this is why usage recording must happen per user-facing operation (one row per `fit`/`tailor`/`prep`/`parse` action), not per internal LLM call — a `fit` operation that makes two internal calls (READ then CROSS) records ONE `usage_events` row summing both calls' tokens/cost, matching how `04-fit/README.md`'s decision treats READ+CROSS+SCORE as one atomic user-facing action (cited in `docs/prd/breakdown-plan.md` §6 open question #8).

## Goal

`lib/usage/record.ts` exporting `recordUsage()` — the single write-path every stage-owning route (LIB-01, FIT-01, TLR-01, PRP-01/02) calls once, after its operation completes (success or failure), to persist a `usage_events` row.

## Non-goals

- No quota/breaker checking — FND-06 (this ticket only writes after the fact; FND-06 checks before).
- No `/admin` aggregation queries — `07-platform-launch`/PLT-03 reads `usage_events` with its own query functions; this ticket does not provide aggregation, only single-row insertion.
- No dropped-count computation — each stage route computes its own dropped count (from FND-07's validation-layer outputs) and passes it in; this ticket does not know what "dropped" means for any given stage.

## File-scope (write-owns)

- `lib/usage/record.ts`, `lib/usage/record.test.ts`
- `lib/schemas/persisted.ts` — this ticket does NOT edit it (only reads/imports `UsageEvent`) unless Deliverable 1's schema-gap resolution requires adding fields, in which case this ticket appends to FND-04's file with an explicit note (see below) since FND-04 is merged before this ticket starts (sequential, `blocked_by: [FND-03]` for FND-04 vs. this ticket's `blocked_by: [FND-05, FND-06]`, both ordered after FND-04 in the module's ticket sequence).
- Does not touch: `db/schema.ts` (FND-05, read/import only — if Deliverable 1 needs new columns, this ticket appends to `db/schema.ts` too, same justification as above).
- Serial-safety: FND-04/05/06 merged before this ticket starts; any append this ticket makes to `lib/schemas/persisted.ts` or `db/schema.ts` is the next sequential touch, no in-flight contention.

## Deliverables

1. Resolve the §5.6-vs-§8.4 gap (Background) by extending `UsageEvent` (in `lib/schemas/persisted.ts`, appended by this ticket) and the `usage_events` Drizzle table (in `db/schema.ts`, appended by this ticket) with two additional fields not in FND-04's original transcription: `droppedCount: z.number().default(0)` and `status: z.enum(['success', 'failure']).default('success')`. Document this extension inline in both files as "added by FND-10 to satisfy PRD §8.4's 'dropped / stage 状态' logging requirement, absent from §5.6's literal code sketch."
2. `lib/usage/record.ts` exporting `async function recordUsage(event: { userId: string; op: UsageOp; tokensIn: number; tokensOut: number; searches: number; durationMs: number; droppedCount?: number; status?: 'success' | 'failure' }): Promise<void>` — computes `costUsd` internally via FND-06's `estimateCostUsd()` (never accepts a pre-computed cost from the caller, so cost calculation stays in exactly one place), then inserts one row into `usage_events` via FND-05's `db` client.
3. `recordUsage()` must not throw on its own DB-write failure in a way that fails the parent request — wrap the insert in a try/catch, log the error (e.g. `console.error`, since PRD §8.4 explicitly rejects standing up an APM), and return normally, so a usage-logging outage never blocks a user-facing operation (this mirrors P3's "Degrade, don't block" spirit even though PRD §2 states P3 specifically about RESEARCH — applying the same posture to observability logging is this ticket's own reasonable extension, documented here as such rather than silently assumed).

## Acceptance checklist (classified)

- [ ] `[machine]` `recordUsage()` inserts a row with `costUsd` computed via FND-06's `estimateCostUsd`, not a caller-supplied value (unit test asserting the caller cannot override `costUsd`, e.g. by checking the function's TypeScript parameter type excludes it).
- [ ] `[machine]` `recordUsage()` defaults `droppedCount` to `0` and `status` to `'success'` when omitted (unit test).
- [ ] `[machine]` `recordUsage()` swallows a simulated DB-insert failure (mocked to throw) without re-throwing (unit test asserting the call resolves, not rejects, when the underlying insert is mocked to fail).
- [ ] `[machine]` `pnpm test` green.

## Test plan

Vitest unit tests in `lib/usage/record.test.ts`, using the same local/in-memory Postgres substitute (or mocked Drizzle client, per whichever fallback FND-05 recorded) established by earlier foundation tickets, asserting the inserted row's shape and the failure-swallowing behavior via a mocked `db.insert(...)` that throws.

## Feedback obligation

1. Every stage-owning ticket (LIB-01, FIT-01, TLR-01, PRP-01, PRP-02) MUST call `recordUsage()` exactly once per user-facing operation, per Background's "one row per operation, not per internal LLM call" decision — if any of those tickets' Builder finds this doesn't fit (e.g. a genuine need for two rows), that's a reversal of this ticket's cost-per-funnel-step design (PRD §9's "成本结构与漏斗形状一致") — escalate to Horace and update this ticket + `01-foundation/README.md`'s decisions table before diverging, don't record two rows silently.
2. The `droppedCount`/`status` field addition (Deliverable 1) is this ticket's own resolution of a real PRD internal gap (§5.6 code sketch vs. §8.4 prose) — if `07-platform-launch`/PLT-03's admin aggregation needs still more fields once it's actually built (e.g. per-field dropped breakdown rather than a single count), PLT-03 appends further to `usage_events` and must record the addition in this ticket's Deliverables list (version +0.1, changelog line in `01-foundation/README.md`), not invent a parallel logging path.
