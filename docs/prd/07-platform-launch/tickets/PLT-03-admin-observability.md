---
id: PLT-03
title: /admin observability page
module: 07-platform-launch
lane: 07-platform-launch
size: M
agent: builder
status: draft
date: 2026-07-17
blocked_by: [FND-10, FND-08]
blocks: []
---

# PLT-03 — /admin observability page

No ADR — the decision is already made in PRD §8.4 (observability policy); this is build ticket 3 of 4 against the `07-platform-launch` module. The admin-authorization MECHANISM is a new decision this ticket makes (PRD names no mechanism), flagged as an open question — see Background.
Parent sub-PRD: [07-platform-launch README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [FND-10 — Usage and cost observability recording helper](../../01-foundation/tickets/FND-10-usage-recording.md), [FND-08 — Auth.js v5 and session/userId scoping helper](../../01-foundation/tickets/FND-08-authjs-session.md)
**Why `builder`:** aggregation queries and a display page against an already-decided `usage_events` schema and a documented, PRD-cited metric list — no open design beyond the admin-auth mechanism (flagged, not silently assumed).

## Background + basis

PRD §8.4, quoted verbatim: "每次操作落 tokens / searches / cost / duration / dropped / stage 状态；`/admin` 页汇总周成本、p50/p95、dropped 率、漏斗转化。不上 APM——一张表加一页汇总就是这个量级 observability 的全部。" — four required aggregate views: (1) weekly cost, (2) p50/p95 latency, (3) dropped rate, (4) funnel conversion. All computed from `usage_events` (FND-10's write path) — no APM, no external dashboard tool.

PRD §7's metrics table names the exact funnel-conversion figures this page should surface: "注册 → 库建成 ≥ 50%；fit → tailor 转化 ≥ 25%；interviewing 状态 job 中生成 brief 的比例 ≥ 60%" — these three ratios are the concrete "漏斗转化" content PRD's §8.4 line refers to.

**Admin authorization is NOT defined anywhere in PRD** — this is a genuine gap this ticket must resolve with a documented decision, not silently invent and bury. Per `07-platform-launch/README.md`'s decision table: this ticket implements an env-var email allowlist (`ADMIN_EMAILS`, comma-separated), consistent in style with PRD §8.3's own env-var patterns ("全局日花费熔断阈值（env）") and §9's "邀请码控制注册节奏" — but this is this ticket's OWN judgment call, flagged as open question #1 in `07-platform-launch/README.md`, owner Horace, pending confirmation.

## Goal

`app/(admin)/admin/page.tsx` (env-var-allowlist-gated page) and `lib/db/queries/admin.ts` (aggregation query functions over `usage_events`) surfacing: weekly cost total, p50/p95 latency per op, dropped rate, and the three PRD §7 funnel-conversion ratios.

## Non-goals

- No APM/external dashboard integration — PRD explicitly rejects this ("不上 APM").
- No real-time/live-updating dashboard — a page that queries on each load is sufficient; PRD names no real-time requirement.
- No per-user drill-down view (e.g. "show me user X's usage history") — PRD's §8.4 line describes aggregate summaries only ("周成本、p50/p95、dropped 率、漏斗转化"), not individual user inspection; adding one would be new surface area touching user privacy (an admin browsing individual users' data) that PRD does not authorize — do not add without an explicit product decision.
- No role/permission system beyond the env-var email allowlist — no `isAdmin` database column, no multi-tier admin roles; PRD's scale ("一张表加一页汇总就是这个量级 observability 的全部") does not warrant one.

## File-scope (write-owns)

- `app/(admin)/admin/page.tsx`, `app/(admin)/admin/_components/**`
- `lib/db/queries/admin.ts`, `lib/db/queries/admin.test.ts`
- `middleware.ts` — append: gate `app/(admin)/**` on BOTH being authenticated AND the session email being in the `ADMIN_EMAILS` allowlist (append-only per `docs/prd/breakdown-plan.md` §3; FND-08 created the file).
- `.env.example` — append `ADMIN_EMAILS` placeholder.
- Does not touch: `lib/usage/record.ts` (FND-10, read/import the `usage_events` table only, no write path changes), any functional module's files.
- Serial-safety: `01-foundation` fully merged before this ticket starts. No dependency on/from `03`–`06`; may run in parallel with them.

## Deliverables

1. `lib/db/queries/admin.ts` exporting:
   - `getWeeklyCost(): Promise<number>` — `SUM(costUsd) FROM usage_events WHERE createdAt >= <7 days ago>`.
   - `getLatencyPercentiles(): Promise<Record<UsageOp, { p50: number; p95: number }>>` — computed per `op` over the same 7-day window from `durationMs`.
   - `getDroppedRate(): Promise<number>` — `SUM(droppedCount) / COUNT(*)` aggregate over the window (using FND-10's `droppedCount` field, added specifically to satisfy this PRD §8.4 requirement per FND-10's own Background).
   - `getFunnelConversion(): Promise<{ signupToLibrary: number; fitToTailor: number; interviewingToBrief: number }>` — the three PRD §7 ratios: `signupToLibrary` = distinct users with a `libraries` row (`projects.length > 0`) / distinct registered users; `fitToTailor` = distinct jobs with a `tailored_resumes` row / distinct jobs with `fit` populated; `interviewingToBrief` = distinct jobs with `status = 'interviewing'` AND a `briefs` row / distinct jobs with `status = 'interviewing'`.
2. `app/(admin)/admin/page.tsx` — server component rendering the four aggregate views (Deliverable 1's four functions), formatted for readability (a simple table/summary layout — PRD names no specific visual design for this internal tool).
3. `middleware.ts` append: for any request under `app/(admin)/**`, in addition to the existing auth gate, check `session.user.email` against `process.env.ADMIN_EMAILS.split(',')` — redirect/403 if not present.

## Acceptance checklist (classified)

- [ ] `[machine]` `getWeeklyCost` sums only rows within the last 7 days (seed rows both inside and outside the window, assert only the in-window sum is returned).
- [ ] `[machine]` `getLatencyPercentiles` computes correct p50/p95 for a hand-seeded set of `durationMs` values per op (deterministic percentile-calculation unit test, not dependent on real data volume).
- [ ] `[machine]` `getFunnelConversion`'s three ratios match hand-computed expected values against a small seeded dataset (e.g. 4 users, 1 with a library → `signupToLibrary: 0.25`).
- [ ] `[machine]` A request to `/admin` from a session whose email is NOT in `ADMIN_EMAILS` is rejected (redirect or 403), and a request from an allowlisted email succeeds — two integration tests directly proving the admin gate.
- [ ] `[machine]` `pnpm test` green.

## Test plan

Integration tests against the local/in-memory Postgres substitute, seeding `usage_events`/`jobs`/`libraries`/`tailored_resumes`/`briefs` rows with known values and asserting each aggregation function's output matches hand-computed expected numbers. The admin-gate test mocks the session's email at both an allowlisted and a non-allowlisted value.

## Feedback obligation

1. **This ticket's admin-auth mechanism is a new decision, not a PRD transcription** — it must be confirmed by Horace before or shortly after P5 launch (per `07-platform-launch/README.md` open question #1); if Horace prefers a different mechanism (e.g. a database `isAdmin` flag, or restricting to Horace's own single account by a hardcoded check), update this ticket (version +0.1, changelog line in `07-platform-launch/README.md`) and change the implementation — do not treat the env-var-allowlist choice as final without that confirmation.
2. If the funnel-conversion ratios computed here diverge meaningfully from what PRD §7's initial targets expect once real data exists (e.g. `signupToLibrary` consistently far below 50%), that is a product-signal finding for Horace, not a bug in this ticket — this ticket's job is correct measurement, not achieving the target.
3. If `usage_events`' current columns (including FND-10's `droppedCount`/`status` extension) prove insufficient for any of the four required views once built against real data, extend `usage_events` further (per FND-10's own Feedback obligation note anticipating this) rather than inventing a parallel aggregation table.

## Changelog

- v0.1 (2026-07-23, PLT-03 Builder writeback): Deliverables 1–3 implemented per `docs/plans/PLT-03.md` on `ticket/PLT-03`. Files added: `lib/db/queries/admin.ts(+.test.ts)`, `app/(admin)/admin/page.tsx(+.test.tsx)`, `app/(admin)/_lib/admin-access.ts(+.test.ts)`; `middleware.ts` / `middleware.test.ts` / `.env.example` appended. **55 PLT-03 tests green across those 4 files**; full suite **407 passed / 2 failed**, both failures pre-existing in PLT-02's `tests/backup.test.ts` and verified identical on a clean `main` (they shell out to `bash`, which is broken in this Windows/WSL environment — not a PLT-03 regression). `next build` with no `DATABASE_URL`/`AUTH_*`: exit 0, `/admin` listed as `ƒ (Dynamic)`. Deviations and load-bearing decisions:
  - **`app/(admin)/_lib/admin-access.ts(+.test.ts)` is not in the ticket's literal File-scope enumeration** (which names `app/(admin)/admin/page.tsx` + `app/(admin)/admin/_components/**`), but `docs/prd/breakdown-plan.md` §3 allocates **`app/(admin)/**`** wholesale to this module, so the path is inside the module's ownership. The predicate needs to exist exactly once because it runs in **two runtimes** — Edge (`middleware.ts`) and Node (the server component) — and two inlined copies is how one of them silently drifts. Same class of File-scope-narrower-than-Deliverables gap PLT-02 recorded for `.github/scripts/backup.mjs`. Recorded, not silently expanded.
  - **`middleware.test.ts` append** — the acceptance checklist mandates the two gate integration tests; the file is 01-foundation-owned and was appended to only (nothing above restructured), same handling PLT-01 recorded for its `PUBLIC_PATHS` append. `middleware.ts`'s `PUBLIC_PATHS` and `config.matcher` are **unchanged**: the existing matcher already covers `/admin` and `/admin/**` (pinned by a new test).
  - **`getLatencyPercentiles` returns `{ p50, p95, samples }`** — an additive superset of the ticket's literal `{ p50, p95 }`, so the stated contract still holds. `samples` exists because there is no honest p50/p95 for an op with zero events in the window: `{p50: 0, p95: 0}` asserts "this stage completed in 0 ms", which is affirmatively false and contrary to PRD §5.5's "宁可暴露不完整，不静默吞掉". The page renders `—` when `samples === 0`. Deliberately asymmetric with `getFunnelConversion`, whose shape is **not** widened with denominators (plan §5 Q4) — a ratio over a small denominator is arithmetically correct, only statistically weak, so that gets a page-level caveat instead.
  - **Optional `nowMs: number = Date.now()` parameter** on the three windowed functions. Additive — the ticket's zero-argument call shape is unchanged and tested — and it makes the 7-day boundary assertions exact instead of racing the wall clock.
  - **`percentile_disc`, not `percentile_cont`** (plan §0.1, measured in PGlite): `percentile_cont` interpolates in `double precision` and returns e.g. `954.9999999999999`, which would render literally on the page. `percentile_disc` returns an actually-observed latency at nearest rank `k = ceil(q·n)`, in exact integer ms.
  - **Both ratios are divided in JS, never in SQL** (plan §0.2/§0.3, measured): `sum(dropped)/count(*)` is bigint/bigint and Postgres **truncates** it (6/11 → `0`), and an empty window would be a division by zero, which Postgres **raises**. The `0.75` assertion in `admin.test.ts` is the standing regression guard. Every raw `sql<number>` aggregate carries `.mapWith(Number)` — without it, PGlite returns numbers and `@neondatabase/serverless` returns strings, i.e. green tests and string math in production (a `typeof` assertion pins this).
  - **Funnel is all-time, not windowed** (plan §5 Q2) — the ticket's definitions name no window, unlike the other three; the page labels the section "all time" so the difference is visible. **Dropped metric is labelled "dropped items per operation", not a rate** (plan §5 Q3), with an on-page note that it is not comparable to PRD §6's Q1 `< 15%` gate, which divides by items considered — that would need a `usage_events` column extension, deliberately **not** made here.
  - **Non-empty-projects check uses a `CASE`, not `jsonb_typeof(...) = 'array' AND jsonb_array_length(...) > 0`** as the plan sketched. SQL's `AND` is not short-circuiting and Postgres may reorder the quals, so the conjunct form can still evaluate `jsonb_array_length` on a non-array row and raise — precisely the failure the guard exists to prevent. `CASE` has defined evaluation order; same intent, actually safe.
  - **Two-layer gate, page-level check authoritative.** Middleware returns a bare `403 Forbidden` (the ticket allows redirect **or** 403; 403 cannot loop and does not bounce an already-authenticated user to a sign-in page); the server component independently calls `isAdminEmail` and `notFound()`s **before** any query runs, so a non-admin reaching the RSC gets no aggregate byte. Tests assert all four query mocks were never called on a rejected request. Do not delete the page-level check on the grounds that middleware covers it — middleware is a separate runtime with build-inlined env semantics (below).
  - **Reviewer, note explicitly (Feedback obligation #1):** the env-var email allowlist is an **unconfirmed product decision this ticket carries**, not a PRD transcription — `07-platform-launch/README.md` open question #1, owner Horace. It is the app's only privileged-access boundary and is an ADR candidate (plan §5 Q1). Fail-closed is implemented and tested at both layers (unset / empty / whitespace-only / commas-only `ADMIN_EMAILS` ⇒ nobody is an admin; the predicate never throws).
  - **Pre-existing issues hit and NOT fixed here** (plan §6.3): `pnpm lint` / `next build`'s lint pass fails with `Cannot find module 'eslint-plugin-react-hooks'` — an install/hoisting gap in `node_modules`, unrelated to this ticket (build still exits 0). And plan §4 R4 stands unverified: whether `auth()` returns a populated `req.auth.user.email` inside the Edge runtime under `session: { strategy: 'database' }` cannot be tested offline; if it does not, this gate denies (fails closed) but so does the whole authenticated app — an FND-08-level infra issue, not a PLT-03 one. Relatedly (plan §5 Q5), Next.js inlines `process.env.ADMIN_EMAILS` into the Edge bundle, so **changing `ADMIN_EMAILS` may require a redeploy** for the middleware half; documented in `.env.example` and in `admin-access.ts`.
