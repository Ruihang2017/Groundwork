---
id: FIT-01
title: Job creation (READ) and lifecycle status route
module: 04-fit
lane: 04-fit
size: M
agent: builder
status: draft
date: 2026-07-17
blocked_by: [FND-03, FND-04, FND-05, FND-06, FND-08, FND-10, LIB-02, EVL-02]
blocks: [FIT-02, TLR-02, PRP-01, PRP-03]
---

# FIT-01 — Job creation (READ) and lifecycle status route

No ADR — the decision is already made in PRD §5.1 (READ row), §5.6 (Job schema/status enum), §5.7 (no-library gate); this is build ticket 1 of 3 against the `04-fit` module.
Parent sub-PRD: [04-fit README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [FND-03 — Pipeline stage payload Zod schemas](../../01-foundation/tickets/FND-03-pipeline-payload-schemas.md), [FND-04 — Persisted entity Zod schemas](../../01-foundation/tickets/FND-04-persisted-entity-schemas.md), [FND-05 — Drizzle schema, Neon Postgres client, and migrations](../../01-foundation/tickets/FND-05-drizzle-schema-neon.md), [FND-06 — Model, pricing, and quota configuration](../../01-foundation/tickets/FND-06-model-pricing-quota-config.md), [FND-08 — Auth.js v5 and session/userId scoping helper](../../01-foundation/tickets/FND-08-authjs-session.md), [FND-10 — Usage and cost observability recording helper](../../01-foundation/tickets/FND-10-usage-recording.md), [LIB-02 — Library persistence API and query helpers](../../03-library/tickets/LIB-02-persistence-api.md), [EVL-02 — Q1-Q3 evaluation harness](../../02-evaluation/tickets/EVL-02-eval-harness.md)
**Why `builder`:** implementing the READ stage plus a generic status-transition route against already-decided schemas/gating rules — no open product design beyond the two flagged open questions carried into `04-fit/README.md`.

## Background + basis

PRD §5.1 READ row: "**READ** | 新建 job | `jdRaw` → `JdExtract` | requirements ≤ 11、weight 1–3（3 = 没有就不招）、每条打 category（technical / experience / domain / logistics）；atsKeywords 列表；subtext ≤ 3 | JSON 修复重试 1 次 → 报错". These constraints are already Zod-enforced by FND-03's `JdExtract` schema; this ticket's job is the prompt + route wiring that produces output satisfying it.

PRD §5.7: "无库时禁止新建 job，CTA 引导导入简历——垃圾进垃圾出，库太薄时产出通用结果等于自毁定位." — this is a hard server-side gate, not just a UI affordance (see `03-library/README.md`'s decision that `hasLibrary()` exists precisely for both LIB-03's client gating AND this route's server-side enforcement).

PRD §5.6: `Job.status: z.enum(['screening', 'applied', 'interviewing', 'closed'])`. A new job's initial status is `'screening'` (the funnel's first state, per PRD §4's funnel narrative: "建库（一次）→ 筛（每个 JD）→ 投…→ 面…" — screening is literally the "筛" step this module implements).

`04-fit/README.md`'s decision table (already made, cited here for the Builder's direct benefit): READ (job creation) and CROSS+SCORE ("Fit") are treated as one atomic user-facing "Fit" operation; the `fit` quota (PRD §8.3: "10 fit"/day) is checked and incremented **once, at this ticket's job-creation step**, before making the READ call — NOT re-checked in FIT-02. This is because PRD §5.1's trigger column lists CROSS's trigger as "Fit" (not READ's "新建 job"), but PRD §8.3 names only one `fit` quota bucket and PRD §4 S2 describes the whole "paste JD → get Fit Report" sequence as one continuous 30-second user action — charging quota once at the start of that action is this ticket's (and `04-fit/README.md`'s) resolution, flagged as a hard-to-reverse architectural choice (see `04-fit/README.md` open question #2 and `docs/prd/breakdown-plan.md` §6 item #8).

`04-fit/README.md`'s decision on status transitions: this ticket owns a GENERIC status-PATCH route (not just the `interviewing` transition) because `05-tailor` (delivered before `06-prep`) also needs to set `status: 'applied'`, and putting the route in the earlier-delivered `04-fit` module avoids `05-tailor` depending on the later-delivered `06-prep` module. PRD only explicitly names the `interviewing` transition's trigger ("用户点击'我拿到面试了'", §5.4); `applied`/`closed` triggers are undefined in PRD — carried as `04-fit/README.md` open question #1, owner Horace. This ticket's PATCH route is enum-validated but otherwise PERMISSIVE (does not enforce a strict state-machine ordering beyond "must be one of the four valid enum values") since PRD names no ordering-violation rule to enforce (e.g. PRD never says "you cannot go from `screening` directly to `interviewing`").

## Goal

`app/api/jobs/route.ts` (`POST`: create a job from `jdRaw`, running READ, gated on library existing, quota-checked once) and `app/api/jobs/[id]/route.ts` (`GET`: fetch one job scoped to the caller; `PATCH`: generic status transition) plus `lib/db/queries/jobs.ts` query helpers for reuse by `04-fit`'s own later tickets and by `05-tailor`/`06-prep`.

## Non-goals

- No CROSS/SCORE — FIT-02 (this ticket only produces `job.jd`; `job.ledger`/`job.fit` do not exist on a freshly-created job until FIT-02's route is called next — see the Non-nullability caveat below).
- **Caveat on FND-04's non-nullable `Job.jd`/`ledger`/`fit`**: FND-04's Zod `Job` schema (the API-facing contract) declares all three fields required — but AT THE DATABASE LEVEL, a job must exist as a row before CROSS+SCORE can populate `ledger`/`fit` (this ticket creates the row with only `jd` known). This ticket's own internal/DB-facing representation therefore differs from the public Zod contract during the brief window between job creation and the immediately-following CROSS+SCORE call — resolve this by having `db/schema.ts`'s `jobs.ledger`/`jobs.fit` columns stay nullable at the DB level (already the case unless FND-05 declared them NOT NULL — verify against FND-05's actual migration; if FND-05 did declare them NOT NULL per that ticket's own Deliverable 1, this ticket must either (a) get FND-05 revised first, since the "atomic Job creation" originally assumed in FND-04/FND-05 conflicts with the two-call READ-then-CROSS design decided in `04-fit/README.md`, or (b) have this route call READ and CROSS+SCORE together in one request after all. **This is a real internal PRD-decomposition inconsistency this ticket's Builder must resolve, not paper over** — see Feedback obligation item 1, which requires escalation rather than a silent choice.
- No Fit Report UI — FIT-03.
- No invite-code/admin logic — `07-platform-launch`.

## File-scope (write-owns)

- `app/api/jobs/route.ts`, `app/api/jobs/[id]/route.ts`, `app/api/jobs/route.test.ts`, `app/api/jobs/[id]/route.test.ts`
- `lib/db/queries/jobs.ts`, `lib/db/queries/jobs.test.ts`
- `lib/read/prompt.ts` (the READ stage prompt, authored fresh — see `04-fit/README.md` open question #4)
- Does not touch: `app/api/jobs/[id]/fit/route.ts` (FIT-02), `lib/scoring/**` (FIT-02), any `app/(app)/**` path (FIT-03).
- Serial-safety: all of `01-foundation`, `02-evaluation`, and `03-library` are fully merged before this ticket starts (per the module execution order in `docs/prd/breakdown-plan.md` §4) — no in-flight contention on any imported file.

## Deliverables

1. `lib/read/prompt.ts` exporting the READ stage prompt (system + instructions), producing `JdExtract` (FND-03) from `jdRaw` text, written fresh per `04-fit/README.md` open question #4.
2. `lib/db/queries/jobs.ts` exporting `createJob(userId, company, role, jdRaw, jd)`, `getJob(userId, jobId)` (scoped, returns `null` if not found or belongs to another user — never distinguishes "not found" from "not yours" in the response, per PRD §8.3's cross-user isolation mandate: leaking existence via a different error would itself be a minor information leak), `updateJobStatus(userId, jobId, status)`, `attachLedgerAndFit(userId, jobId, ledger, fit)` (used by FIT-02, exported here since `jobs.ts` is this ticket's file but the function is called by a sibling ticket in the same module/lane — acceptable same-lane sequential reuse).
3. `app/api/jobs/route.ts` `POST` handler: (a) `requireUserId()`; (b) `hasLibrary(userId)` (LIB-02) — if `false`, return HTTP 403 `{ error: 'no_library' }` (server-side mirror of PRD §5.7's gate); (c) `checkAndIncrementQuota(userId, 'fit')` (FND-06) — if not allowed, return HTTP 429 `{ error: 'quota_exceeded', op: 'fit', resetAt }`; (d) `checkGlobalBreaker()` (FND-06) — if tripped, HTTP 503; (e) call the Anthropic API with `PRIMARY_MODEL` (FND-06) and the READ prompt, parse against `JdExtract` (FND-03) with one JSON-repair retry, error HTTP 422 on unrecoverable failure per PRD's "JSON 修复重试 1 次 → 报错"; (f) `createJob(...)` with `status: 'screening'`; (g) `recordUsage()` (FND-10) with `op: 'read'` — note this is `'read'`, not `'fit'`, because `UsageOp` (FND-04) has no `'fit'` value, only the six pipeline-stage names; the QUOTA bucket is `'fit'` (FND-06's `DAILY_QUOTA` key) while the USAGE-EVENT op is `'read'` — these are two different enums serving different purposes, do not conflate them; (h) return the created `Job` with HTTP 201.
4. `app/api/jobs/[id]/route.ts` `GET` handler: `requireUserId()`, `getJob(userId, id)`, HTTP 404 if `null`, else the `Job` with HTTP 200.
5. `app/api/jobs/[id]/route.ts` `PATCH` handler: `requireUserId()`, parses body against `z.object({ status: JobStatus })` (FND-04), verifies the job belongs to the caller (via `getJob`), calls `updateJobStatus`, returns the updated `Job` with HTTP 200. No additional state-machine ordering enforcement beyond enum validity, per Background.

## Acceptance checklist (classified)

- [ ] `[machine]` `POST /api/jobs` for a user with `hasLibrary() === false` returns HTTP 403 `{ error: 'no_library' }` and never calls the Anthropic client (mocked, assert zero calls) — direct machine proof of PRD §5.7's gate.
- [ ] `[machine]` `POST /api/jobs` calls `checkAndIncrementQuota(userId, 'fit')` exactly once per call, before the Anthropic call (mocked quota function, assert call order via a spy).
- [ ] `[fixture]` For each of EVL-01's 10 JD fixtures (`fixtures/jds/*.md`), calling this route (with the Anthropic client mocked to return a canned valid `JdExtract`-shaped response tuned to each fixture's content) produces a job whose `jd` field parses against FND-03's `JdExtract` schema, `requirements.length <= 11`. Wired through `02-evaluation`/EVL-02's `assertQ1Schema` — this is the concrete `[fixture]` acceptance item feeding PRD §10 P2's "Q1 全绿" for the READ half of Fit.
- [ ] `[machine]` `PATCH /api/jobs/[id]` rejects a `status` value outside the four-member enum with HTTP 400 (Zod rejection).
- [ ] `[machine]` `GET /api/jobs/[id]` for a job belonging to a different `userId` returns HTTP 404 (not 403 — see Deliverable 2's information-leak note), cross-user isolation test.
- [ ] `[machine]` `pnpm test` green.

## Test plan

Unit/integration tests mocking the Anthropic client (same pattern as `03-library`/LIB-01) and using the local/in-memory Postgres substitute (FND-05's established pattern) for `lib/db/queries/jobs.ts`. The `[fixture]` item runs against all 10 EVL-01 JD fixtures in a loop, asserting schema validity per fixture — reproducible offline (mocked model responses, no real API spend in CI). Cross-user isolation and no-library-gate tests seed two distinct users directly via Drizzle before asserting route behavior.

## Feedback obligation

1. **Escalate, do not silently resolve**: the internal inconsistency flagged in Non-goals (FND-04's non-nullable `Job.jd`/`ledger`/`fit` Zod contract vs. this ticket's two-call READ-then-CROSS design needing an intermediate "jd-only" DB state) must be resolved by (a) confirming with FND-05's actual generated migration whether `jobs.ledger`/`jobs.fit` are DB-level `NOT NULL`, and (b) if they are, filing this as a required amendment to FND-05 (version +0.1, changelog line in `01-foundation/README.md`) making those two columns DB-nullable while keeping the Zod `Job` schema (the API response contract, only ever returned once complete) non-nullable — i.e., the DB row can be transiently incomplete, but this route never RETURNS a `Job` object over the API until FIT-02 completes it. Do not proceed past this ticket's implementation without recording which resolution was chosen, since FIT-02 depends on the DB-level shape being correct.
2. The atomic-"Fit"-operation / single-quota-charge design (Background) is explicitly flagged as ADR-candidate material — if real usage after P5 launch shows users abandoning between job-creation and Fit-report (e.g. READ succeeds but the client never calls FIT-02, wasting the quota charge with no report produced), that is exactly the kind of data PRD §13's open-questions process expects; escalate to Horace rather than silently changing where quota is charged.
3. The READ prompt (`lib/read/prompt.ts`) is new, hand-authored content (no legacy asset, per `04-fit/README.md` open question #4) — if it underperforms against real (non-mocked) fixture testing during `pnpm eval` runs once wired end-to-end, fix here and record the regression case per `02-evaluation/README.md`'s changelog convention, same as LIB-01's Feedback obligation item 1.
