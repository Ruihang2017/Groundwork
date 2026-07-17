---
id: FND-04
title: Persisted entity Zod schemas
module: 01-foundation
lane: 01-foundation
size: S
agent: builder
status: draft
date: 2026-07-17
blocked_by: [FND-03]
blocks: [FND-05, FIT-01, TLR-01, PRP-04, EVL-02]
---

# FND-04 — Persisted entity Zod schemas

No ADR — the decision is already made in PRD §5.6 (data model sketch) and §6 (eval_runs); this is build ticket 4 of 10 against the `01-foundation` module.
Parent sub-PRD: [01-foundation README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [FND-03 — Pipeline stage payload Zod schemas](FND-03-pipeline-payload-schemas.md)
**Why `builder`:** transcribing PRD §5.6's code sketch (which directly embeds FND-03's types) into Zod schemas is mechanical composition, not new design.

## Background + basis

PRD §5.6, quoted verbatim (the load-bearing source):

```ts
// 漏斗主实体：job 携带状态推进，ledger 产出一次、三处复用
const Job = z.object({
  id: z.string(), userId: z.string(), company: z.string(), role: z.string(),
  status: z.enum(['screening', 'applied', 'interviewing', 'closed']),
  jdRaw: z.string(), jd: JdExtract,
  ledger: Ledger,               // bindings + gaps（Fit 产出，Tailor / Prep 复用）
  fit: FitReport,               // 硬性条件 + 4 子分 + 综合分（代码计算）
});
const TailoredResume = z.object({ jobId: z.string(), alignment: Alignment, edits: z.array(Edit), fullDraftMd: z.string() });
const Brief = z.object({ jobId: z.string(), intel: Intel.nullable(), rehearse: Rehearse });

// 记账：成本与延迟从第一天可观测
const UsageEvent = z.object({ userId: z.string(), op: z.string(), tokensIn: z.number(),
  tokensOut: z.number(), searches: z.number(), costUsd: z.number(), durationMs: z.number() });
```

Note `Job.jd`, `Job.ledger`, `Job.fit` are all **non-nullable/required** — this is load-bearing: a `Job` row is only ever created once READ has produced a `JdExtract` (per `04-fit`/FIT-01's design, quoting the module's own decision), and `ledger`/`fit` are only ever set together, in the same request, because CROSS (LLM) and SCORE (pure code) execute atomically in one API call (see `04-fit/README.md`'s decision on this — carried forward from `docs/prd/breakdown-plan.md` §6 open question #8). This ticket must NOT make `jd`/`ledger`/`fit` optional to "make Job creation easier" — that would silently change the funnel's data-integrity guarantee.

`Brief.intel` is explicitly `.nullable()` (PRD's own annotation) — this encodes P3 ("Degrade, don't block", PRD §2): RESEARCH may fail and a Brief still gets created with `intel: null`. `Brief.rehearse` is NOT nullable — REHEARSE failure is NOT degraded (PRD §5.1 REHEARSE row failure policy: "同上" = "JSON 修复重试 1 次 → 报错", same as READ/CROSS, i.e. it errors out rather than persisting a partial Brief).

PRD §5.6 prose (below the code block) also states: "Postgres 表：`users / libraries / resumes / jobs / tailored_resumes / briefs / usage_events / eval_runs`。库为资产：写操作留 `updatedAt`，删除为软删防手滑；**删号 = 硬删该用户全部数据**。" — `eval_runs` is named as a table but has no code sketch. PRD §6 additionally says: "每次 prompt / 模型改动必跑，报告落 `eval_runs`" — a report needs at minimum which suite, which op, a pass rate, and details. This ticket defines a minimal `EvalRun` schema per the decision recorded in `01-foundation/README.md`'s decisions table (flagged there as inferred, not literally specified, with an open question for `02-evaluation` to confirm sufficiency).

## Goal

`lib/schemas/persisted.ts` exporting Zod v4 schemas for `Job`, `TailoredResume`, `Brief`, `UsageEvent`, `EvalRun`, importing `JdExtract`/`Ledger`/`FitReport`/`Alignment`/`Edit`/`Intel`/`Rehearse` from `lib/schemas/pipeline.ts` (FND-03) — these are the schemas the API route handlers in every downstream feature module validate their persisted rows against, and Drizzle (FND-05) mirrors as Postgres tables.

## Non-goals

- No Drizzle table definitions — FND-05 (this ticket is Zod-only).
- No `Project`/`Library`/`Resume`/`Profile` — already done in FND-02; this ticket does not redefine or import them (Job/TailoredResume/Brief reference library data only via `userId`, never embed `Library`/`Project` directly, per the §5.6 sketch above — no import from `entities.ts` needed).
- No invite-code table or admin/usage-aggregation query schemas — `07-platform-launch` (PLT-04, PLT-03) define anything they need locally, not here (this ticket is fixed to exactly what PRD §5.6 + §6 name).

## File-scope (write-owns)

- `lib/schemas/persisted.ts`
- `lib/schemas/persisted.test.ts`
- Does not touch: `lib/schemas/entities.ts` (FND-02), `lib/schemas/pipeline.ts` (FND-03, read/import only, no edits).
- Serial-safety: FND-01/02/03 precede this ticket and are merged; `pipeline.ts` (FND-03) is a completed, merged dependency by the time this ticket starts — no in-flight contention.

## Deliverables

1. `JobStatus = z.enum(['screening', 'applied', 'interviewing', 'closed'])`.
2. `Job = z.object({ id: z.string(), userId: z.string(), company: z.string(), role: z.string(), status: JobStatus, jdRaw: z.string(), jd: JdExtract, ledger: Ledger, fit: FitReport, createdAt: z.number(), updatedAt: z.number() })` — `createdAt`/`updatedAt` added beyond the literal §5.6 sketch because PRD prose requires "写操作留 `updatedAt`" for asset-tracked rows; document this addition inline as an FND-04 extension.
3. `TailoredResume = z.object({ jobId: z.string(), alignment: Alignment, edits: z.array(Edit), fullDraftMd: z.string(), createdAt: z.number(), updatedAt: z.number() })`.
4. `Brief = z.object({ jobId: z.string(), intel: Intel.nullable(), rehearse: Rehearse, createdAt: z.number(), updatedAt: z.number() })`.
5. `UsageOp = z.enum(['parse', 'read', 'cross', 'tailor', 'research', 'rehearse'])` — the six pipeline stages from PRD §5.1's table (SCORE excluded: it is pure code with no model call, so it never produces a `UsageEvent` row on its own — it is recorded as part of the `cross` op's single event, matching FND-10's "usage recorded once per user-facing operation" design carried from `04-fit`'s decision).
6. `UsageEvent = z.object({ userId: z.string(), op: UsageOp, tokensIn: z.number(), tokensOut: z.number(), searches: z.number(), costUsd: z.number(), durationMs: z.number(), createdAt: z.number() })` — `createdAt` added (needed for the daily-window quota/breaker queries FND-06 builds; not in the literal §5.6 sketch, documented inline as an FND-04 extension).
7. `EvalSuite = z.enum(['q1', 'q2', 'q3'])`.
8. `EvalRun = z.object({ id: z.string(), suite: EvalSuite, op: UsageOp, passRate: z.number().min(0).max(1), details: z.record(z.string(), z.unknown()), createdAt: z.number() })` — flagged inline as an FND-04 design inference per `01-foundation/README.md`'s decisions table (PRD names the table, not its fields).
9. Corresponding `export type X = z.infer<typeof X>` for every schema above.

## Acceptance checklist (classified)

- [ ] `[machine]` `Job.parse(...)` rejects an object missing `jd`, `ledger`, or `fit` (all three required, not optional) — unit test asserting this explicitly, because it is the load-bearing atomicity guarantee described in Background.
- [ ] `[machine]` `Brief.parse({..., intel: null, rehearse: {...valid...}})` succeeds — `intel` nullable, `rehearse` required — unit test.
- [ ] `[machine]` `Brief.parse({..., intel: {...valid...}})` with `rehearse` omitted fails — unit test.
- [ ] `[machine]` `UsageEvent.op` rejects `'score'` as an invalid value (SCORE never produces its own usage event, per Deliverable 5) — unit test.
- [ ] `[machine]` `pnpm test` green.

## Test plan

Vitest unit tests in `lib/schemas/persisted.test.ts`. Build one valid `Job`/`TailoredResume`/`Brief`/`UsageEvent`/`EvalRun` fixture object per schema inline (using minimal valid `JdExtract`/`Ledger`/`FitReport`/etc. sub-objects, reusing the same construction pattern as `lib/schemas/pipeline.test.ts` from FND-03), then assert both the happy path and each Background-cited constraint (Job's three required fields, Brief's nullable/required split, UsageOp's closed enum).

## Feedback obligation

1. `EvalRun`'s shape is explicitly flagged as inferred (see Background) — if `02-evaluation`/EVL-02 finds it insufficient once building the real harness, EVL-02 edits `lib/schemas/persisted.ts` directly and must update this ticket's Deliverable 8 (version +0.1, changelog line in `01-foundation/README.md`) recording what changed and why, before wiring the harness to it.
2. If `Job.jd`/`ledger`/`fit` non-nullability is found to be unworkable once `04-fit`/FIT-01 is actually implemented (e.g. the client genuinely needs to persist a job before READ completes), that overturns the atomicity decision described in Background — this is NOT a local fix inside FIT-01; escalate to Horace and update this ticket + `04-fit/README.md`'s decisions table first, per the "hard-to-reverse architectural choice" flag already recorded in `docs/prd/breakdown-plan.md` §6 open question #8.
