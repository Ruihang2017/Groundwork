---
id: FND-05
title: Drizzle schema, Neon Postgres client, and migrations
module: 01-foundation
lane: 01-foundation
size: M
agent: builder
status: draft
date: 2026-07-17
blocked_by: [FND-02, FND-04]
blocks: [FND-06, FND-08, FND-10, EVL-02, LIB-02, FIT-01, TLR-01, PRP-04, PLT-01, PLT-02, PLT-04]
---

# FND-05 — Drizzle schema, Neon Postgres client, and migrations

No ADR — the decision is already made in PRD §8.1 ("DB：SQLite → Neon Postgres … Drizzle 让迁移成本一次付清") and §5.6 (table list); this is build ticket 5 of 10 against the `01-foundation` module.
Parent sub-PRD: [01-foundation README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [FND-02 — Core simple-entity Zod schemas](FND-02-core-entity-schemas.md), [FND-04 — Persisted entity Zod schemas](FND-04-persisted-entity-schemas.md)
**Why `builder`:** table shapes are dictated by FND-02/FND-04's already-decided Zod schemas plus PRD §5.6's explicit table list; no new modeling decisions beyond how to store nested objects (jsonb).

## Background + basis

PRD §5.6 prose: "Postgres 表：`users / libraries / resumes / jobs / tailored_resumes / briefs / usage_events / eval_runs`。库为资产：写操作留 `updatedAt`，删除为软删防手滑；**删号 = 硬删该用户全部数据**。" This ticket creates all eight tables. `users` additionally needs Auth.js's own required columns (Drizzle adapter contract) — FND-08 (Auth.js) depends on this ticket for exactly that reason.

PRD §8.3 (security/privacy): "数据隔离：全部查询以 session userId 约束，无跨用户查询路径。" — every table except `users` itself must carry a `userId` (or, for `jobs`-scoped children like `tailored_resumes`/`briefs`, a path back to `userId` via `jobs.userId`) so every query this repo ever writes can filter on it.

PRD §5.6: "库为资产：写操作留 `updatedAt`，删除为软删防手滑" — this governs `libraries`/`resumes` specifically (the "library" as an asset); `jobs`/`tailored_resumes`/`briefs` also get `updatedAt` per FND-04's schema (Deliverable 2–4 there) but PRD's soft-delete language ("删除为软删防手滑") is stated in the context of the library, so this ticket adds a `deletedAt: timestamp | null` column to `libraries` specifically, not to every table — hard delete (account deletion) is `07-platform-launch`/PLT-01's job and cascades across all tables regardless of any table's soft-delete column.

PRD §8.1: "简历解析**原始文件解析后即弃、不落盘**——只存 markdown 与结构化库". This means the `resumes` table stores exactly `Resume` (FND-02: `sourceMd`, `updatedAt`) and nothing else — no file blob column, no file path column.

## Goal

`db/schema.ts` (Drizzle table definitions for all eight tables), `db/index.ts` (Neon serverless driver client export), `drizzle.config.ts`, and a generated initial migration under `db/migrations/`, such that `pnpm db:generate` / `pnpm db:migrate` scripts exist and running them against a `DATABASE_URL` produces the eight tables.

## Non-goals

- No Auth.js-specific adapter wiring (the `accounts`/`sessions`/`verification_tokens` tables Auth.js's Drizzle adapter needs) — FND-08 adds those, in the same `db/schema.ts` file (an explicit append, not a rewrite — see File-scope).
- No `invite_codes` table — `07-platform-launch`/PLT-04 appends it later (see `docs/prd/breakdown-plan.md` §3, this file is one of the four cross-module append-only files).
- No query helper functions beyond the bare Drizzle client export — `lib/db/queries/**` files belong to each feature module (`03-library`, `04-fit`, `05-tailor`, `06-prep`, `07-platform-launch`).
- No quota-counter table — PRD §8.1 says quota is Postgres-counter-based via counting `usage_events` rows (no separate table); FND-06 reads this table, does not need a new one.

## File-scope (write-owns)

- `db/schema.ts`, `db/index.ts`, `drizzle.config.ts`, `db/migrations/**`
- `package.json` — append `"db:generate"`/`"db:migrate"` scripts and `drizzle-orm`/`drizzle-kit`/`@neondatabase/serverless` dependencies only (append-only per `docs/prd/breakdown-plan.md` §3; FND-01 created the file, do not restructure existing scripts/deps).
- `.env.example` — append `DATABASE_URL` placeholder if not already present from FND-01 (FND-01 already lists it; verify, do not duplicate).
- Does not touch: `lib/schemas/**` (FND-02/03/04, read/import only for type reference in comments — Drizzle's own column types are independent of Zod, no runtime import needed).
- Serial-safety: FND-01/02/03/04 are merged before this ticket starts; `package.json` was last touched by FND-01 (merged) — this ticket's append is the second touch, safe per the sequential module/ticket execution order, no in-flight contention.

## Deliverables

1. `db/schema.ts` defining, using `drizzle-orm/pg-core`:
   - `users` — Auth.js Drizzle-adapter-compatible base shape (`id`, `name`, `email`, `emailVerified`, `image`) — FND-08 appends `accounts`/`sessions`/`verificationTokens` next to this table in the same file.
   - `libraries` — `id`, `userId` (FK → `users.id`), `profile` (jsonb, matches `Profile`), `projects` (jsonb array, matches `Project[]`), `createdAt`, `updatedAt`, `deletedAt` (nullable timestamp, soft delete per Background).
   - `resumes` — `id`, `userId` (FK), `sourceMd` (text), `updatedAt`. No file/blob columns (Background: originals are discarded).
   - `jobs` — `id`, `userId` (FK), `company`, `role`, `status` (pg enum matching `JobStatus`), `jdRaw` (text), `jd` (jsonb, matches `JdExtract`), `ledger` (jsonb, matches `Ledger`), `fit` (jsonb, matches `FitReport`), `createdAt`, `updatedAt`. `jd`/`ledger`/`fit` are NOT nullable columns, mirroring FND-04's non-nullable Zod fields — this is the DB-level enforcement of the same atomicity guarantee.
   - `tailored_resumes` — `id`, `jobId` (FK → `jobs.id`), `alignment` (jsonb), `edits` (jsonb array), `fullDraftMd` (text), `createdAt`, `updatedAt`. (`userId` reachable via `jobs.userId` — every query joins through `jobs` for user-scoping, per Background's §8.3 citation.)
   - `briefs` — `id`, `jobId` (FK), `intel` (jsonb, nullable), `rehearse` (jsonb, not null), `createdAt`, `updatedAt`.
   - `usage_events` — `id`, `userId` (FK), `op` (pg enum matching `UsageOp`), `tokensIn`, `tokensOut`, `searches`, `costUsd` (numeric), `durationMs`, `createdAt`. Add an index on `(userId, op, createdAt)` — this is the column set FND-06's quota/breaker queries and `07-platform-launch`/PLT-03's admin aggregation both scan by.
   - `eval_runs` — `id`, `suite` (pg enum matching `EvalSuite`), `op` (pg enum matching `UsageOp`), `passRate` (numeric), `details` (jsonb), `createdAt`.
2. `db/index.ts` exporting a singleton Drizzle client (`drizzle-orm/neon-http` or `neon-serverless`, per Neon's Vercel-serverless-compatible driver) constructed from `process.env.DATABASE_URL`, throwing a clear error at import time if the env var is missing (fail fast, not a silent undefined client).
3. `drizzle.config.ts` pointing at `db/schema.ts`, dialect `postgresql`, migrations output to `db/migrations/`.
4. `package.json` scripts: `"db:generate": "drizzle-kit generate"`, `"db:migrate": "drizzle-kit migrate"` (or the FND-01-established equivalent invocation for the installed drizzle-kit version).
5. One generated initial migration file under `db/migrations/` covering all eight tables (produced by actually running `drizzle-kit generate` against `db/schema.ts`, not hand-written).

## Acceptance checklist (classified)

- [ ] `[machine]` `pnpm db:generate` runs without error and produces a migration file covering all eight tables.
- [ ] `[machine]` A unit/integration test (using a disposable local Postgres — e.g. `pg-mem` or a Docker-based test container if available in the environment; if neither is available, mock at the Drizzle-query level and note the gap explicitly in Deviations) verifies `db/schema.ts` exports all eight table objects with the columns listed in Deliverable 1.
- [ ] `[machine]` `jobs.jd`/`jobs.ledger`/`jobs.fit` columns are declared `NOT NULL` in the generated migration SQL (grep/parse check) — the DB-level mirror of FND-04's non-nullable Zod fields.
- [ ] `[machine]` `usage_events` has a composite index on `(userId, op, createdAt)` (checked in the generated migration SQL).
- [ ] `[machine]` `pnpm test` green.
- [ ] `[human]` A real Neon `DATABASE_URL` is provisioned by Horace and `pnpm db:migrate` is run against it at least once before any downstream module that writes to the DB starts real (non-mocked) integration testing — this is an infrastructure hand-off Horace must complete (see Feedback obligation), not something this ticket's automated tests can verify.

## Test plan

1. Schema-shape tests: import `db/schema.ts` and assert (via Drizzle's own table introspection API, e.g. `getTableColumns()`) that each table has the columns listed in Deliverable 1, with the `NOT NULL` constraints called out.
2. Migration-generation test: run `pnpm db:generate` in a scratch directory copy and assert the command exits 0 and a `.sql` file appears under `db/migrations/`.
3. If a local Postgres test double is available in this environment (check for Docker or an existing `pg-mem`-style package already used elsewhere in similar repos before adding a new dependency — none exists yet here, so evaluate `pg-mem` as a lightweight in-memory Postgres-compatible driver for this ticket's own tests only), run the generated migration against it and assert insert/select round-trips for one row per table using FND-02/FND-04's own Zod-valid fixture objects (reuse the construction pattern from `lib/schemas/persisted.test.ts`).
4. If no such test double is feasible in this environment, the ticket's tests fall back to schema-shape + migration-generation checks only (items 1–2 above), and the Builder records this gap explicitly in Deviations — do not silently skip without a note, since it weakens this ticket's own machine coverage of the NOT NULL/index guarantees to static SQL inspection only.

## Feedback obligation

1. General rule: if a jsonb column's shape needs to diverge from its Zod counterpart (e.g. Postgres enum limitations forcing a `text` column instead of a true pg enum for `status`), update this ticket (version +0.1, changelog line in `01-foundation/README.md`) documenting the divergence and why, before other modules write queries against it.
2. Real Neon provisioning (`DATABASE_URL` for a live database) requires Horace's Neon account — carried forward as open question in `01-foundation/README.md` (see FND-01's equivalent note for Vercel). Until provisioned, all of this ticket's own tests and every downstream module's integration tests must run against a local/in-memory Postgres-compatible substitute, not a live Neon instance — flag this explicitly if any downstream ticket's Test plan assumes a live `DATABASE_URL` without checking for one first.
3. If the soft-delete convention (`libraries.deletedAt`) is found to need to extend to other tables once `07-platform-launch`/PLT-01 implements hard account-delete, that ticket must NOT reinterpret "soft delete" as covering `jobs`/`tailored_resumes`/`briefs` — those tables have no `deletedAt` column by this ticket's design (only `libraries` does, per Background); PLT-01's hard delete cascades by `DELETE ... WHERE userId = ?` / join-through-`jobs`, not by toggling a soft-delete flag. If that's wrong, it's a schema decision reversal — escalate, don't silently add columns.
