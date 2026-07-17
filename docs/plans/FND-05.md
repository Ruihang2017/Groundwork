# Implementation plan — FND-05: Drizzle schema, Neon Postgres client, and migrations

Ticket: [docs/prd/01-foundation/tickets/FND-05-drizzle-schema-neon.md](../prd/01-foundation/tickets/FND-05-drizzle-schema-neon.md)
Sub-PRD: [docs/prd/01-foundation/README.md](../prd/01-foundation/README.md)
Master spec: [docs/PRD.md](../PRD.md) §5.6 (data model sketch + Postgres table list, `updatedAt`/soft-delete prose), §8.1 (stack pin: Drizzle + Neon; "简历解析原始文件解析后即弃、不落盘"), §8.3 ("数据隔离：全部查询以 session userId 约束，无跨用户查询路径")
Breakdown plan file-ownership table: [docs/prd/breakdown-plan.md](../prd/breakdown-plan.md) §3 (`db/schema.ts`, `db/index.ts`, `drizzle.config.ts`, `db/migrations/**` → `01-foundation`/FND-05 creates; PLT-04 appends `invite_codes` via a new migration, not by editing existing table defs; FND-08 appends `accounts`/`sessions`/`verificationTokens`), general append-only policy (line 41: "新增导出/新增表/新增字段，不重构既有内容")
Depends on (merged): [docs/plans/FND-02.md](FND-02.md) (`lib/schemas/entities.ts` — `Profile`/`Project`/`Library`/`Resume`), [docs/plans/FND-04.md](FND-04.md) (`lib/schemas/persisted.ts` — `Job`/`TailoredResume`/`Brief`/`UsageEvent`/`EvalRun`, and their enums). Not a hard dependency but read for context: `lib/schemas/pipeline.ts` (FND-03, merged; its types are embedded inside FND-04's persisted-entity schemas).
Downstream (read this plan's decisions before starting): FND-06 (`usage_events` reads; explicitly told to reuse "the same local/in-memory Postgres substitute decided in FND-05's Test plan... or, if that ticket recorded a Deviation falling back to mocked Drizzle queries, follow the same fallback"), FND-08 (appends `accounts`/`sessions`/`verificationTokens` to `db/schema.ts`, and its acceptance checklist explicitly re-runs "FND-05's own schema-shape tests unchanged for the original eight tables" as a regression check), FND-10 (appends `droppedCount`/`status` to `usage_events`, imports `db` from `db/index.ts`).

This plan is cold-startable: a Builder with no access to the planning conversation can execute it from this file plus the ticket alone.

## 0. Repo-state check performed for this plan (do not re-derive, just confirm unchanged)

Verified at planning time (2026-07-18) by direct inspection, not assumption:

- `git log --oneline`: HEAD is `5651865` (merge ticket/FND-04 into main). `git branch --list "ticket/FND-05"` is empty — **no in-flight FND-05 branch exists**. Working tree clean (`git status` reports "nothing to commit"). **`5651865` is the base commit** the Builder's diff should be measured against.
- `db/` does not exist anywhere in the repo yet — this ticket creates it from scratch (`db/schema.ts`, `db/index.ts`, `db/migrations/**`), plus `drizzle.config.ts` at repo root.
- `lib/schemas/entities.ts` (FND-02, merged) exports `Profile`, `Project`, `Library`, `Resume` (+ inferred types). `lib/schemas/persisted.ts` (FND-04, merged) exports `JobStatus`, `Job`, `TailoredResume`, `Brief`, `UsageOp`, `UsageEvent`, `EvalSuite`, `EvalRun` (+ inferred types), composing `lib/schemas/pipeline.ts`'s (FND-03) `JdExtract`/`Ledger`/`FitReport`/`Alignment`/`Edit`/`Intel`/`Rehearse`. Read in full for this plan (all three files) — the field lists and nullability quoted throughout this plan are transcribed directly from those files, not from the ticket's paraphrase, so any future drift between ticket prose and actual code should defer to the code.
- Load-bearing shape fact used repeatedly below: **none of `Library`, `Resume`, `TailoredResume`, `Brief`, `UsageEvent` carry an `id` field in their Zod schema** (only `Job` and `EvalRun` do — `id: z.string()`). `TailoredResume`/`Brief` carry `jobId: z.string()` only (no `userId` — reachable only via `jobs.userId`). This is expected and matches the ticket's own Deliverable 1 column lists verbatim (e.g. "`resumes` — `id`, `userId` (FK), `sourceMd` (text), `updatedAt`" lists `id`/`userId` even though `Resume` the Zod type is only `{ sourceMd, updatedAt }`) — the DB row is a strict superset of the Zod *payload* schema for these tables; `id`/`userId`/`jobId`-as-FK are persistence-layer additions, not something `db/schema.ts` needs to reconcile against the Zod schema's own field list.
- **All `createdAt`/`updatedAt`/`deletedAt`-shaped fields across every FND-02/FND-04 Zod schema are `z.number()` (epoch-ms), never `z.date()`** — confirmed by direct read (`Resume.updatedAt`, `Job.createdAt`/`updatedAt`, `TailoredResume.createdAt`/`updatedAt`, `Brief.createdAt`/`updatedAt`, `UsageEvent.createdAt`, `EvalRun.createdAt`) and by `entities.ts`'s own inline comment on `Resume.updatedAt` ("same as entities.ts's Resume.updatedAt precedent, no z.date()", repeated verbatim in `persisted.ts`'s header comment). This is a repo-wide, deliberate convention, not an accident — see §2.1's column-type decision and §6 (ADR-candidate flag) for why this plan follows it in the DB layer too.
- `vitest.config.ts` currently has `test.include: ['tests/**/*.test.ts', 'lib/**/*.test.ts']` — **does not include `db/**`**. This is the same situation FND-02 hit and fixed by widening the glob (`01-foundation/README.md` v0.3 changelog: "否则 pnpm test 会假绿（跑 0 条本票断言)"). This ticket's `db/schema.test.ts` (and any other `db/**/*.test.ts` file) will not be picked up by `pnpm test` unless this glob is widened again. **`vitest.config.ts` is not listed in this ticket's File-scope** — flagged explicitly in §2.4 as a required, precedented writeback (not a scope violation), following FND-02's exact playbook.
- `tsconfig.json`'s `include` (`["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", "tests/**/*.ts"]`) already covers any future `db/**/*.ts` via the bare `**/*.ts` glob (not folder-scoped) — confirmed no `tsconfig.json` change needed. The `@/*` → repo-root path alias (`paths: { "@/*": ["./*"] }`) already resolves `@/db/schema` and `@/db/index` once those files exist.
- `eslint.config.mjs` applies `next/core-web-vitals` + `next/typescript` to everything except `.next/**`, `node_modules/**`, `out/**`, `build/**`, `next-env.d.ts` — `db/**` is linted by default already, no config change needed.
- `package.json` currently has zero `drizzle-*`/`@neondatabase/*` packages (confirmed: `node_modules/drizzle-orm`, `node_modules/drizzle-kit`, `node_modules/@neondatabase` all absent). Latest published versions checked against the npm registry at planning time: `drizzle-orm@0.45.2`, `drizzle-kit@0.31.10`, `@neondatabase/serverless@1.1.0`, `pg-mem@3.0.14`. Node engine pin is `>=20` (repo's own `package.json`); local dev Node is `v22.11.0` — both comfortably satisfy every package above's own engine requirements.
- **Docker**: CLI is installed locally (`docker --version` → `25.0.3`) but **the daemon is not running** (`docker info` → `Server: ERROR: ... docker daemon is not running`). `.github/workflows/ci.yml` (FND-01, `ubuntu-latest` runner) has no `services:` block and this ticket's File-scope does not include `.github/workflows/ci.yml` — a Docker-based Postgres test container is therefore **not a viable option for this ticket**, locally or in CI, without a File-scope-exceeding edit to `ci.yml`. This directly resolves the ticket's own Test-plan item 3 fork ("check for Docker or an existing pg-mem-style package") in favor of evaluating `pg-mem`, not Docker. See §2.3.

## 1. Scope

**In scope:**

- New file `db/schema.ts` — Drizzle `pg-core` table definitions for all eight PRD §5.6 tables: `users`, `libraries`, `resumes`, `jobs`, `tailored_resumes`, `briefs`, `usage_events`, `eval_runs`, plus the three pg enums they need (`job_status`, `usage_op`, `eval_suite`).
- New file `db/index.ts` — a singleton Drizzle client built on `drizzle-orm/neon-http` + `@neondatabase/serverless`, throwing at import time if `DATABASE_URL` is unset.
- New file `drizzle.config.ts` (repo root) — `dialect: 'postgresql'`, `schema: './db/schema.ts'`, `out: './db/migrations'`.
- New file `db/schema.test.ts` — schema-shape unit tests (Deliverable/Test-plan item 1), structured so FND-08 can literally re-run it unmodified as its own regression check after appending `accounts`/`sessions`/`verificationTokens` (FND-08's acceptance checklist item 3 depends on this file's shape — see §2.2).
- New file `db/migrate.test.ts` — migration-generation regression test (Test-plan item 2) + NOT-NULL/index SQL assertions (acceptance items 3–4) + the optional pg-mem round-trip (Test-plan item 3/4) — see §2.3 for exactly what runs and what the documented fallback is.
- One generated migration under `db/migrations/` (an `.sql` file + `meta/_journal.json` + `meta/0000_snapshot.json`, or whatever `drizzle-kit generate` actually names them), produced by literally running `pnpm db:generate` against the finished `db/schema.ts` — **never hand-authored**.
- `package.json` — append `drizzle-orm`, `@neondatabase/serverless` to `dependencies`; `drizzle-kit` to `devDependencies`; append `"db:generate": "drizzle-kit generate"` and `"db:migrate": "drizzle-kit migrate"` to `scripts`. (See §2.4 for the `pg-mem`/`pg` devDependency question, which is a flagged exception to this ticket's literal File-scope wording, not silently assumed.)
- `vitest.config.ts` — widen `test.include` to add `'db/**/*.test.ts'` (required writeback, precedented by FND-02 — see §0 and §2.4).
- `.env.example` — verify `DATABASE_URL` is already present (it is, from FND-01) — **no edit**.
- `01-foundation/README.md` — one changelog line recording the `vitest.config.ts` writeback (mirrors FND-02's own changelog entry format) and, separately, one changelog line (or an inline `db/schema.ts` comment cross-referenced from the README's decisions table) recording the epoch-ms-bigint timestamp convention as a now-decided, repo-wide convention downstream tickets can rely on. See §2.4 and §6.

**Explicitly out of scope** (per ticket Non-goals — do not implement, even opportunistically):

- No Auth.js adapter tables (`accounts`/`sessions`/`verificationTokens`) — FND-08 appends these to `db/schema.ts` later, after this ticket merges. Do not stub them.
- No `invite_codes` table — PLT-04, via a later, separate migration.
- No query helper functions (`lib/db/queries/**`) of any kind — not even a trivial `getLibraryByUserId` example. Feature modules (03–07) own these.
- No quota-counter table — FND-06 counts `usage_events` rows directly.
- No edits to `lib/schemas/**` — read-only for context (see §2.1's `import type` decision, which is itself flagged as an interpretation call, not an edit).
- No real Neon database provisioning, no running `pnpm db:migrate` against a live instance — that is explicitly a `[human]` acceptance item for Horace (ticket Feedback obligation #2). This ticket's own tests must not assume a live `DATABASE_URL`.
- No `.github/workflows/ci.yml` edit — not in File-scope; confirmed in §0 that no viable test strategy in this plan requires one (pg-mem needs no service container).

## 2. Change list

### 2.1 `db/schema.ts` (new file)

Imports:
```ts
import { relations } from 'drizzle-orm'; // only if relations helpers are used — optional, see note below
import {
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

// Type-only references for jsonb column typing — erased at compile time, zero
// runtime coupling to lib/schemas/**. See the interpretation note below this
// list; flagged in §5 Open Questions for the Reviewer to confirm or overrule.
import type { Profile, Project } from '@/lib/schemas/entities';
import type {
  Alignment,
  Edit,
  FitReport,
  Intel,
  JdExtract,
  Ledger,
  Rehearse,
} from '@/lib/schemas/pipeline';
```

**Interpretation decision — flagged, not silent.** The ticket's File-scope says: "Does not touch: `lib/schemas/**` (FND-02/03/04, read/import only for type reference in comments — Drizzle's own column types are independent of Zod, no runtime import needed)." This plan reads "no runtime import needed" as permission to use `import type { ... }` (fully erased by TypeScript, zero runtime footprint, and `tsconfig.json`'s `isolatedModules: true` already requires the explicit `import type` form for type-only imports — so this is the idiomatic way to satisfy "no runtime import" in this codebase, not a workaround). The alternative, stricter reading — literally no `import` statement of any kind, only prose comments — is captured as Open Question #1 in §5, with a one-line, fully mechanical fallback (delete the `import type` lines, drop the corresponding `.$type<T>()` calls or replace them with a hand-written inline literal type) if the Reviewer disagrees. The reason this plan doesn't just play it safe and skip typing entirely: an untyped jsonb column gives the compiler zero ability to catch exactly the kind of "jsonb column's shape diverges from its Zod counterpart" drift the ticket's own Feedback obligation #1 is worried about — a type-only import is what makes that drift compiler-detectable in the one file (`db/schema.ts`) where it would otherwise go unnoticed until a downstream query-helper ticket hits a runtime shape mismatch.

**Column-type decision — bigint epoch-ms, not native `timestamp`, for every `createdAt`/`updatedAt`/`deletedAt`.** Every FND-02/FND-04 Zod schema's timestamp-shaped field is `z.number()` (epoch-ms), confirmed in §0. The ticket's own Test-plan item 3 requires round-tripping "FND-02/FND-04's own Zod-valid fixture objects" — and those fixtures (see `lib/schemas/persisted.test.ts`, e.g. `createdAt: 1_700_000_000_000`) are raw JS numbers, not `Date` objects. If these columns were native Postgres `timestamp` (which `drizzle-orm/pg-core`'s `timestamp()` maps to a JS `Date` by default), inserting those exact fixtures would not even type-check, let alone round-trip — the ticket's own specified test would be impossible to satisfy literally as written. Use `bigint(<db-name>, { mode: 'number' })` for `createdAt`, `updatedAt` (on `libraries`/`jobs`/`tailored_resumes`/`briefs`), `deletedAt` (on `libraries`), and `createdAt` (on `usage_events`/`eval_runs`) — this maps 1:1 to `z.number()` with zero conversion layer at every insert/select call site, present or future. `bigint(..., { mode: 'number' })` returns a JS `number` (not `bigint`), which is safe here since epoch-ms values are far below `Number.MAX_SAFE_INTEGER`. **Exception: `users.emailVerified` stays native `timestamp('email_verified', { mode: 'date' })`** — this column's shape is dictated by the Auth.js Drizzle-adapter contract (FND-08's dependency, not this app's own Zod schemas — there is no `User` Zod schema anywhere in `lib/schemas/**`), and Auth.js's adapter works with JS `Date` there, not epoch-ms numbers. Do not "fix" this exception for consistency; it would break FND-08's adapter wiring.

Enums (define once, reuse where a table needs the same value set):
```ts
export const jobStatusEnum = pgEnum('job_status', [
  'screening',
  'applied',
  'interviewing',
  'closed',
]); // matches lib/schemas/persisted.ts JobStatus

export const usageOpEnum = pgEnum('usage_op', [
  'parse',
  'read',
  'cross',
  'tailor',
  'research',
  'rehearse',
]); // matches lib/schemas/persisted.ts UsageOp — 'score' deliberately excluded, same
    // reason as the Zod enum: SCORE is pure code, folded into the 'cross' usage event.
    // Reused verbatim (not re-declared) for eval_runs.op below.

export const evalSuiteEnum = pgEnum('eval_suite', ['q1', 'q2', 'q3']); // matches EvalSuite
```

Tables (write in this order; `users`/`jobs` must precede any table that references them via `.references()`):

1. **`users`** — Auth.js Drizzle-adapter-compatible base shape. Exactly the five columns the ticket names, no more (no `createdAt`/`updatedAt` — not requested, and `users` isn't governed by this app's own `updatedAt`-tracking convention).
   ```ts
   export const users = pgTable('users', {
     id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
     name: text('name'),
     email: text('email').notNull().unique(),
     emailVerified: timestamp('email_verified', { mode: 'date' }),
     image: text('image'),
   });
   ```
   `id`/`.unique()` on `email` follow the Auth.js Drizzle-adapter Postgres example convention (an account-uniqueness invariant Auth.js's own sign-in/account-linking flow depends on) — not literally spelled out in the ticket's bare column list, but a safe, standard addition; flagged in §5 Open Question #3 in case FND-08's Builder finds the installed Auth.js adapter version disagrees.

2. **`libraries`**
   ```ts
   export const libraries = pgTable(
     'libraries',
     {
       id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
       userId: text('user_id')
         .notNull()
         .references(() => users.id, { onDelete: 'cascade' }),
       profile: jsonb('profile').notNull().$type<Profile>(),
       projects: jsonb('projects').notNull().$type<Project[]>().default([]),
       createdAt: bigint('created_at', { mode: 'number' })
         .notNull()
         .$defaultFn(() => Date.now()),
       updatedAt: bigint('updated_at', { mode: 'number' })
         .notNull()
         .$defaultFn(() => Date.now())
         .$onUpdate(() => Date.now()),
       deletedAt: bigint('deleted_at', { mode: 'number' }), // nullable — soft delete
     },
     (table) => [index('libraries_user_id_idx').on(table.userId)],
   );
   ```
   `deletedAt` nullable timestamp = soft delete, per Background/PRD §5.6 prose — **this column exists on `libraries` only**, not on any other table (ticket Feedback obligation #3 pins this explicitly; do not add it elsewhere even by analogy).

3. **`resumes`**
   ```ts
   export const resumes = pgTable(
     'resumes',
     {
       id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
       userId: text('user_id')
         .notNull()
         .references(() => users.id, { onDelete: 'cascade' }),
       sourceMd: text('source_md').notNull(),
       updatedAt: bigint('updated_at', { mode: 'number' })
         .notNull()
         .$defaultFn(() => Date.now())
         .$onUpdate(() => Date.now()),
     },
     (table) => [index('resumes_user_id_idx').on(table.userId)],
   );
   ```
   No file/blob columns (Background: "简历解析原始文件解析后即弃、不落盘" — PRD §8.1). No `createdAt` — not in the ticket's column list for this table (matches `Resume`'s own Zod shape, which also has no `createdAt`).

4. **`jobs`**
   ```ts
   export const jobs = pgTable(
     'jobs',
     {
       id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
       userId: text('user_id')
         .notNull()
         .references(() => users.id, { onDelete: 'cascade' }),
       company: text('company').notNull(),
       role: text('role').notNull(),
       status: jobStatusEnum('status').notNull(),
       jdRaw: text('jd_raw').notNull(),
       jd: jsonb('jd').notNull().$type<JdExtract>(),
       ledger: jsonb('ledger').notNull().$type<Ledger>(),
       fit: jsonb('fit').notNull().$type<FitReport>(),
       createdAt: bigint('created_at', { mode: 'number' })
         .notNull()
         .$defaultFn(() => Date.now()),
       updatedAt: bigint('updated_at', { mode: 'number' })
         .notNull()
         .$defaultFn(() => Date.now())
         .$onUpdate(() => Date.now()),
     },
     (table) => [index('jobs_user_id_idx').on(table.userId)],
   );
   ```
   `jd`/`ledger`/`fit` are `.notNull()` with **no** `.default()`/nullable escape hatch — this is acceptance-checklist item 3's literal target (grep the generated migration SQL for `NOT NULL` on these three columns). This is the DB-level mirror of `Job`'s Zod-level atomicity guarantee (Background, FND-04's plan §4 risk note) — do not relax under any circumstance without the escalation path FND-04's ticket Feedback obligation #2 already specifies.

5. **`tailored_resumes`**
   ```ts
   export const tailoredResumes = pgTable(
     'tailored_resumes',
     {
       id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
       jobId: text('job_id')
         .notNull()
         .references(() => jobs.id, { onDelete: 'cascade' }),
       alignment: jsonb('alignment').notNull().$type<Alignment>(),
       edits: jsonb('edits').notNull().$type<Edit[]>(),
       fullDraftMd: text('full_draft_md').notNull(),
       createdAt: bigint('created_at', { mode: 'number' })
         .notNull()
         .$defaultFn(() => Date.now()),
       updatedAt: bigint('updated_at', { mode: 'number' })
         .notNull()
         .$defaultFn(() => Date.now())
         .$onUpdate(() => Date.now()),
     },
     (table) => [index('tailored_resumes_job_id_idx').on(table.jobId)],
   );
   ```
   No direct `userId` column — user-scoping happens via a join through `jobs.userId`, per Background's explicit citation of PRD §8.3. Every downstream query-helper ticket touching this table must join through `jobs` to enforce isolation; this plan documents the expectation in a `db/schema.ts` comment above this table (see §4 risk note) since Drizzle/Postgres cannot enforce "always join through jobs" declaratively.

6. **`briefs`**
   ```ts
   export const briefs = pgTable(
     'briefs',
     {
       id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
       jobId: text('job_id')
         .notNull()
         .references(() => jobs.id, { onDelete: 'cascade' }),
       intel: jsonb('intel').$type<Intel>(), // nullable — RESEARCH may fail (P3)
       rehearse: jsonb('rehearse').notNull().$type<Rehearse>(),
       createdAt: bigint('created_at', { mode: 'number' })
         .notNull()
         .$defaultFn(() => Date.now()),
       updatedAt: bigint('updated_at', { mode: 'number' })
         .notNull()
         .$defaultFn(() => Date.now())
         .$onUpdate(() => Date.now()),
     },
     (table) => [index('briefs_job_id_idx').on(table.jobId)],
   );
   ```
   `intel` nullable / `rehearse` required mirrors `Brief`'s Zod-level asymmetry exactly (same P3 "degrade, don't block" vs. hard-fail justification as FND-04's plan documents).

7. **`usage_events`**
   ```ts
   export const usageEvents = pgTable(
     'usage_events',
     {
       id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
       userId: text('user_id')
         .notNull()
         .references(() => users.id, { onDelete: 'cascade' }),
       op: usageOpEnum('op').notNull(),
       tokensIn: integer('tokens_in').notNull(),
       tokensOut: integer('tokens_out').notNull(),
       searches: integer('searches').notNull(),
       costUsd: numeric('cost_usd', { mode: 'number' }).notNull(),
       durationMs: integer('duration_ms').notNull(),
       createdAt: bigint('created_at', { mode: 'number' })
         .notNull()
         .$defaultFn(() => Date.now()),
     },
     (table) => [
       index('usage_events_user_op_created_idx').on(table.userId, table.op, table.createdAt),
     ],
   );
   ```
   Composite index is acceptance-checklist item 4's literal target — column order `(userId, op, createdAt)` matches the ticket's literal wording and FND-06's stated query pattern (`COUNT(*) WHERE userId = ? AND op = ? AND createdAt >= ...`). `numeric(..., { mode: 'number' })`: verify this option exists on the installed `drizzle-orm@0.45.2`'s `numeric()` signature (`node_modules/drizzle-orm/pg-core/columns/numeric.d.ts` or equivalent) before relying on it — if the installed version lacks `mode: 'number'`, fall back to `.$type<number>()` on a plain `numeric('cost_usd').notNull()` (a compile-time-only cast; Drizzle will still return a string at runtime in that case, so also add an explicit `Number(...)` conversion note in a comment for whichever query-helper ticket reads this column first — flag as a Deviation if this fallback is needed, since it means a genuine string→number conversion, not just a type assertion, must happen somewhere).

8. **`eval_runs`**
   ```ts
   export const evalRuns = pgTable('eval_runs', {
     id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
     suite: evalSuiteEnum('suite').notNull(),
     op: usageOpEnum('op').notNull(), // reuses the same pg enum type as usage_events.op
     passRate: numeric('pass_rate', { mode: 'number' }).notNull(),
     details: jsonb('details').notNull().$type<Record<string, unknown>>(),
     createdAt: bigint('created_at', { mode: 'number' })
       .notNull()
       .$defaultFn(() => Date.now()),
   });
   ```
   No index required by the ticket's acceptance checklist for this table — none added.

Do not add `relations()` helper definitions (Drizzle's separate relational-query-builder API) — not requested by any Deliverable, and `lib/db/queries/**` (out of scope here) is where any relational query convenience belongs, per each feature module's own design. Drop the `relations` import from the top of the file if unused, to avoid an unused-import lint failure.

### 2.2 `db/schema.test.ts` (new file)

Structure this so it can be run **byte-for-byte unmodified** after FND-08 appends three more tables to `db/schema.ts` (FND-08's own acceptance checklist item 3 explicitly requires this: "`db/schema.ts` (after this ticket's append) still passes FND-05's own schema-shape tests unchanged for the original eight tables"). Concretely:

- One `describe` block per table, asserting via `getTableColumns(table)` (from `drizzle-orm`) that the returned column map has exactly the keys this ticket's Deliverable 1 lists (no more, no fewer — an accidental extra column from a copy-paste is exactly the kind of thing this catches) and that each column's `.notNull` boolean matches this plan's §2.1 design (e.g. `jobs.jd.notNull === true`, `briefs.intel.notNull === false`).
- Assert each pg enum's `.enumValues` array equals the exact literal list (`jobStatusEnum.enumValues` → `['screening','applied','interviewing','closed']`, etc.) — this is a second, independent check on `jobs.status`/`usage_events.op`/`eval_runs.suite`/`eval_runs.op` beyond the bare "column exists" check.
- Assert `usageEvents`'s underlying Postgres table name is `'usage_events'` etc. (via `getTableName()` from `drizzle-orm`) for every table — catches an accidental table-name typo that a column-only check would miss.
- Import everything under test via the `@/db/schema` alias (`import { users, libraries, ... } from '@/db/schema';`), matching this repo's established test-file alias convention (`lib/schemas/*.test.ts` all use `@/lib/schemas/...`).
- Do **not** import anything from `db/index.ts` in this file — `db/schema.ts` has no runtime dependency on `DATABASE_URL`, and this test suite must be runnable with zero environment variables set (confirms Feedback obligation #2's "all of this ticket's own tests... must run against a local/in-memory Postgres-compatible substitute, not a live Neon instance" — schema-shape tests need no substitute at all, they're pure introspection).

### 2.3 `db/migrate.test.ts` (new file) — migration generation, NOT NULL/index SQL checks, and the pg-mem round-trip decision

This file covers Test-plan items 2–4 and acceptance-checklist items 1–2. Concretely, three tiers, in increasing order of risk (implement and commit all three that turn out feasible; document explicitly, per the ticket's own instruction, if a tier is dropped):

**Tier 1 — migration-generation regression test (always feasible, always required).** Copy `db/schema.ts` and a minimal `drizzle.config.ts` (pointing `out` at a fresh `fs.mkdtempSync(path.join(os.tmpdir(), 'fnd05-'))` directory) and run `drizzle-kit generate` against the copy via `node:child_process`'s `execFileSync` (prefer `execFileSync` over `execSync` — avoids shell-quoting issues with the temp path on Windows). Assert the process exits 0 and at least one `.sql` file appears under the temp `out` directory. This needs no `DATABASE_URL` (`generate` is schema-file-only introspection, confirmed in §0 — no live DB touched). This is a genuine child-process spawn from inside a Vitest test; keep the timeout generous (`drizzle-kit`'s esbuild-based CLI bundling has noticeable cold-start cost) — set an explicit per-test timeout (e.g. 30s) rather than relying on Vitest's default.

**Tier 2 — static SQL assertions on the real, committed migration (acceptance items 1, 3, 4).** After Deliverable 5's real `db/migrations/0000_*.sql` exists (produced once, for real, per §2.5's implementation-order note — not regenerated by this test), read that file's text and assert with regexes:
- All eight table names appear in a `CREATE TABLE` statement.
- `"jd" jsonb NOT NULL`, `"ledger" jsonb NOT NULL`, `"fit" jsonb NOT NULL` (or whatever exact casing/quoting `drizzle-kit generate` emits — verify the literal emitted text once by reading the generated file rather than guessing the exact string to regex against) all appear in the `jobs` table's `CREATE TABLE` block.
- A `CREATE INDEX` (or `CREATE UNIQUE INDEX`, but this one isn't unique) statement targets `usage_events` and lists `user_id`, `op`, `created_at` in that column order.

**Tier 3 — pg-mem round-trip insert/select (Test-plan item 3, optional, evaluate empirically).** §0 already rules out Docker. Attempt `pg-mem` (`newDb()` → `db.adapters.createPg()` → `new Pool()` from the returned adapter → `drizzle(pool, { schema })` from `drizzle-orm/node-postgres`, **a different Drizzle driver import than `db/index.ts`'s production `neon-http` driver** — this is expected and fine, since `pg-mem`'s adapter only speaks the `pg`/`node-postgres` wire-protocol shape, not Neon's HTTP protocol; the table/column definitions in `db/schema.ts` are driver-agnostic, only the client construction differs). Concretely:
1. Run the real generated migration SQL (from `db/migrations/0000_*.sql`) against the pg-mem instance (`pg-mem` can execute arbitrary SQL text directly via its `db.public.none(sql)` API, or via Drizzle's own `migrate()` helper from `drizzle-orm/node-postgres/migrator` pointed at `db/migrations` — prefer the latter if it works, since it's the same migration-runner code path production ends up using).
2. For each of the eight tables, build one Zod-valid fixture using the exact construction pattern already established in `lib/schemas/persisted.test.ts` (for `Job`/`TailoredResume`/`Brief`/`UsageEvent`/`EvalRun`) and `lib/schemas/entities.test.ts` (for `Library`/`Resume`, plus a `Profile` for `libraries.profile`) — do not invent new fixture shapes; copy the nested-object construction style from those files so the fixtures are already known-valid against FND-02/FND-04's schemas.
3. Insert each fixture (adding the DB-only `id`/`userId`/`jobId` fields §0 already flagged as expected additions) via `db.insert(table).values(...)`, then `db.select().from(table)` and assert the round-tripped row matches the inserted values field-for-field (this is what actually proves the `bigint`/`numeric` `mode` choices in §2.1 work end-to-end, not just type-check).

**If Tier 3 fails** (pg-mem's SQL parser rejects some part of the generated DDL, or a round-trip value comes back mistyped/mismatched in a way that isn't a one-line fix) — **do not spend more than a bounded, small effort debugging pg-mem internals.** Delete the Tier 3 test file/describe block, keep Tiers 1–2, and write the gap explicitly into this ticket's own Deviations section at build time, per the ticket's Test-plan item 4's own instruction ("do not silently skip without a note, since it weakens this ticket's own machine coverage of the NOT NULL/index guarantees to static SQL inspection only"). This also directly determines what FND-06/FND-10's own Test plans do next (§0), so state the outcome (worked / didn't, and why) plainly in the Deviations note — those tickets read it.

### 2.4 `package.json`, `vitest.config.ts`, `01-foundation/README.md` writebacks

- **`package.json`**: append to `dependencies`: `"drizzle-orm": "^0.45.2"`, `"@neondatabase/serverless": "^1.1.0"`. Append to `devDependencies`: `"drizzle-kit": "^0.31.10"`. Append to `scripts`: `"db:generate": "drizzle-kit generate"`, `"db:migrate": "drizzle-kit migrate"`. This exactly matches the ticket's literal File-scope grant.
  - **Flagged tension, resolve explicitly, don't silently expand scope:** the ticket's File-scope sentence names exactly these three runtime/dev packages ("... dependencies only"), but its own Test-plan item 3 asks the Builder to "evaluate `pg-mem` as a lightweight in-memory Postgres-compatible driver for this ticket's own tests only" — which requires adding `pg-mem` (and possibly `pg`, if `drizzle-orm/node-postgres`'s TypeScript types resolve against the real `pg` package's types even when the runtime object is pg-mem's mock — verify this empirically; if `pg`'s types are needed, add `pg`'s official `@types/pg` too if `pg` itself isn't already a transitive type source) as `devDependencies`. This plan's resolution: treat "dependencies... only" as bounding *production* dependencies (the three named packages ship in the deployed app), and treat `pg-mem`/`pg`/`@types/pg` — if Tier 3 (§2.3) turns out feasible — as a narrowly-scoped, test-only addition explicitly authorized by the same ticket's Test-plan section, not a File-scope violation. Record this reasoning as a one-line Deviations note at build time regardless of which way Tier 3 goes, so the Reviewer sees the call was made deliberately. If the Reviewer disagrees, the fallback is mechanical: drop the three packages, drop Tier 3, keep Tiers 1–2 (already what happens if pg-mem doesn't work technically, per §2.3 — so this is a low-cost disagreement to resolve either way).
- **`vitest.config.ts`**: change `test.include` from `['tests/**/*.test.ts', 'lib/**/*.test.ts']` to `['tests/**/*.test.ts', 'lib/**/*.test.ts', 'db/**/*.test.ts']`. Required — §0 confirms `db/schema.test.ts`/`db/migrate.test.ts` are otherwise silently never run (`pnpm test` would report green with zero of this ticket's own assertions actually executing — the exact false-green failure mode FND-02's README changelog entry already names and warns against repeating).
- **`01-foundation/README.md`**: add one Changelog line (v0.3 → v0.4, this ticket's version) recording (a) the `vitest.config.ts` `db/**` glob widening, in the same style as the existing FND-02 v0.3 entry, and (b) one sentence naming the epoch-ms-`bigint` timestamp convention as now decided for every Drizzle table in the repo (so a future ticket touching `db/schema.ts` — FND-08, PLT-04 — doesn't have to re-derive it from reading `db/schema.ts`'s inline comments alone). This is this ticket's own version bump (e.g. `FND-05` ticket file `date`/version metadata, if the ticket file has a version field to bump — check the ticket frontmatter at build time; if it has no `version:` field yet unlike FND-01's, add one starting at `0.1` alongside this changelog entry, matching FND-01's precedent).
- **`.env.example`**: verify only — `DATABASE_URL=` is already present (FND-01). No edit.

### 2.5 `db/index.ts` (new file)

```ts
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';

import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set. Set it in your environment (see .env.example) before importing db/index.ts.',
  );
}

const sql = neon(connectionString);

export const db = drizzle(sql, { schema });
```

**Driver choice: `drizzle-orm/neon-http`, not `neon-serverless`.** The ticket permits either. This plan picks `neon-http` because: (a) it's the simpler, zero-persistent-connection option, a good match for Vercel serverless functions doing single-query-per-request work (which is everything this app's routes need per PRD §5.1–§5.4's per-request pipeline stages); (b) `neon-serverless` needs a `ws` (WebSocket) polyfill in the Node.js runtime and adds `Pool` lifecycle management this app has no other need for yet; (c) `neon()`'s constructor is lazy (no eager connection attempt), which is exactly what makes the fail-fast-on-missing-`DATABASE_URL` behavior below cheap to unit test without a real DB (see §3 item 5) — constructing with a syntactically-plausible-but-fake connection string doesn't error until a query actually runs. **Trade-off flagged, not buried:** `neon-http` does not support real multi-statement interactive transactions (`BEGIN`/`COMMIT` across separate round-trips) the way `neon-serverless` (or plain `node-postgres`) does — Neon's HTTP driver only supports a single-request "batch" of statements as a pseudo-transaction. Nothing in this ticket's own scope needs a real interactive transaction (every write here is a single-row insert). The place this could bite later is `07-platform-launch`/PLT-01's hard account-delete (Feedback obligation #3: "DELETE ... WHERE userId = ? / join-through-jobs" across multiple tables) — if that needs true atomicity across several `DELETE` statements, PLT-01's Builder may need to swap `db/index.ts` to `neon-serverless` (a contained, mechanical change — the `pg-core` schema/table objects in `db/schema.ts` don't change) or accept best-effort sequential deletes. Flagged in §5 Open Question #4 and §6.

## 3. Test plan

Maps to the ticket's acceptance checklist; each item is what the Builder/Reviewer actually runs.

1. `pnpm db:generate` exits 0 and produces `db/migrations/0000_*.sql` covering all eight `CREATE TABLE` statements (acceptance item 1) — proven twice: once for real (Deliverable 5, committed), once as an ongoing regression via §2.3 Tier 1's scratch-copy test.
2. `db/schema.test.ts` (§2.2) asserts all eight table objects export with the exact column sets from Deliverable 1, including `.notNull` flags and enum value lists (Test-plan item 1).
3. §2.3 Tier 2's regex assertions against the real committed migration SQL confirm `jobs.jd`/`ledger`/`fit` are `NOT NULL` (acceptance item 3) and `usage_events` has the `(userId, op, createdAt)` composite index (acceptance item 4).
4. §2.3 Tier 3 (pg-mem round-trip) runs if feasible; if not, the gap is recorded explicitly in Deviations per the ticket's own instruction — either outcome satisfies the ticket's Test-plan item 4 fork.
5. **New test, not explicitly in the ticket's acceptance checklist but proving Deliverable 2's literal text** ("throwing a clear error at import time if the env var is missing"): a `db/index.test.ts` (or a section of `db/schema.test.ts` — Builder's choice, but keep it in a `db/**/*.test.ts`-glob-covered file) that (a) with `process.env.DATABASE_URL` deleted, dynamically `import('@/db/index')` inside a `vi.resetModules()`-wrapped `it()` and asserts the import rejects/throws with a message mentioning `DATABASE_URL`; (b) with a syntactically valid dummy connection string set (e.g. `'postgresql://user:pass@fake-host.example.invalid/db'`), asserts the same dynamic import resolves without throwing (no real network call happens at construction time per the driver-choice note in §2.5 — confirm this empirically once `@neondatabase/serverless` is installed, since it's asserted here from general knowledge of the package's laziness, not from having run it in this repo yet).
6. `pnpm test` exits 0 overall (acceptance item 5), including the pre-existing `tests/smoke.test.ts`, `tests/toolchain.test.ts`, `lib/schemas/*.test.ts` suites unaffected, plus every new `db/**/*.test.ts` file actually discovered (confirms the `vitest.config.ts` widening in §2.4 took effect — if it didn't, `pnpm test` would falsely report green with zero of this ticket's assertions run; explicitly check the test-run output lists the new files, don't just check the exit code).
7. `pnpm build` (or `pnpm exec tsc --noEmit`) once, after `db/schema.ts`/`db/index.ts` are complete — same "cheap insurance beyond Vitest's non-typechecking esbuild transpile" rationale as FND-04's plan §3 item 3; particularly relevant here given the `.$type<T>()`/`import type` usage in §2.1, which is exactly the kind of thing a type error could hide from Vitest but not from `tsc`.
8. `git diff --stat 5651865..HEAD` (base commit confirmed in §0) should list exactly: `db/schema.ts`, `db/index.ts`, `db/schema.test.ts`, `db/migrate.test.ts`, `db/index.test.ts` (if separate), `db/migrations/**` (generated), `drizzle.config.ts`, `package.json`, `pnpm-lock.yaml` (regenerated by `pnpm install` after the `package.json` edit), `vitest.config.ts`, `01-foundation/README.md`. Anything else (in particular any edit inside `lib/schemas/**`, `.github/workflows/ci.yml`, or `.env.example`) is a File-scope violation and must be reverted before merge.
9. Everything above is reproducible fully offline except the `[human]` acceptance item (a real `pnpm db:migrate` against a provisioned Neon `DATABASE_URL`, which is explicitly Horace's job, not this ticket's automated tests' — do not write a test that assumes a live `DATABASE_URL`, per Feedback obligation #2).

## 4. Risks & edge cases

- **Concurrency: no query-helper code exists in this ticket, so no request-level race conditions are introduced here** — same category of finding as FND-02/FND-03/FND-04's plans. The one place concurrency-adjacent reasoning applies is the `.$onUpdate(() => Date.now())` callback on every `updatedAt` column (§2.1): this is evaluated client-side by `drizzle-orm` at the moment `.update()` is called, not inside a DB transaction/lock, so two concurrent `UPDATE`s to the same row will each stamp their own `Date.now()` and the later `UPDATE` to actually commit wins (last-write-wins on `updatedAt`, same as on every other updated column) — this is standard, expected Postgres MVCC behavior, not a new risk this ticket introduces, but worth a one-line comment in `db/schema.ts` since it's a schema-level (not query-level) mechanism a future Reviewer might not expect to find outside a query-helper file.
- **Security-sensitive path: PRD §8.3's "无跨用户查询路径" (no cross-user query path) is enforced entirely at the application query layer, not at the DB layer.** This ticket adds `userId`/`jobId` foreign keys and indexes (§2.1) that make userId-scoped queries *efficient*, and it documents the join-through-`jobs` expectation for `tailored_resumes`/`briefs` in schema comments — but Postgres has no Row-Level Security (RLS) policy configured here, and none is proposed (not mentioned anywhere in PRD/ADRs, and inventing one would be new-architecture scope this ticket's "no new modeling decisions beyond jsonb" framing doesn't cover). This means there is currently **no DB-level backstop** if a future query-helper ticket (FIT-01, TLR-01, PRP-04, etc.) writes a query that omits its `userId`/join-through-`jobs` filter — the bug would only surface as a real cross-user data leak in production, not a schema-level rejection. Flag this explicitly to the Reviewer as a standing architectural gap this ticket is aware of but does not close (RLS setup, if ever wanted, would be its own ticket/ADR) — the mitigation this ticket *does* provide is the comment-level documentation of which column/join every table's isolation depends on (§2.1), so the expectation is at least visible to every downstream Builder.
- **`onDelete: 'cascade'` on every `userId`/`jobId` foreign key (§2.1) is an addition beyond the ticket's literal Deliverable 1 text (which says "FK", not "FK ON DELETE CASCADE").** Rationale: defense-in-depth referential integrity, consistent with (not contradicting) PLT-01's planned explicit multi-table `DELETE ... WHERE userId = ?` hard-delete flow (Feedback obligation #3) — if PLT-01's explicit deletes run first, cascade is a no-op; if PLT-01 ever deletes a `users` row directly, cascade prevents orphaned child rows as a safety net. Flagged as §5 Open Question #2 in case the Reviewer or Horace wants this reconsidered before PLT-01 is actually built (cheap to change now via a follow-up migration; expensive to discover missing after real user data exists).
- **`jsonb` columns have no DB-level structural validation** — Postgres only guarantees "this is valid JSON", not "this matches `Profile`/`JdExtract`/etc.'s shape". The `.$type<T>()` compile-time annotations (§2.1) give TypeScript-level safety at every call site that goes through Drizzle's typed query builder, but provide **zero runtime protection** if a caller ever bypasses Zod validation (e.g. a raw SQL escape hatch, or a bug in a future query-helper that inserts an object that type-checks accidentally but isn't actually Zod-valid). This is inherent to the architecture PRD already chose (Zod-at-the-boundary, not DB-level JSON schema validation) — not something this ticket should "fix", but worth naming so the Reviewer doesn't mistake `.$type<T>()` for a runtime guarantee it isn't.
- **Migration-file immutability going forward.** This ticket's Deliverable 5 migration is the *only* migration in the repo once merged. Every subsequent `db/schema.ts` change (FND-08's Auth.js tables, PLT-04's `invite_codes`) must run `drizzle-kit generate` again to produce a **new** migration file — never hand-edit `db/migrations/0000_*.sql` after the fact. Add a one-line comment to this effect at the top of `db/schema.ts` so it's visible in the file every future append touches.
- **`pg-mem` (if Tier 3 ships) is a community-maintained, not officially-Postgres-certified SQL engine** — a passing Tier 3 test proves compatibility with pg-mem's SQL dialect subset, not with real Neon Postgres. This is exactly why the ticket frames it as a supplementary check, not a replacement for the `[human]` acceptance item (a real `pnpm db:migrate` against provisioned Neon, per Feedback obligation #2) — do not let a green Tier 3 create false confidence that the schema is proven against real Postgres.
- **Windows-specific note (this plan was authored on a Windows dev machine, `win32`):** `execFileSync`/temp-directory handling in §2.3 Tier 1 should use `node:os.tmpdir()` and `node:path.join` (not hardcoded POSIX paths) so the test is portable to the Linux CI runner (`ubuntu-latest`, per `.github/workflows/ci.yml`) as well as local Windows development — call this out explicitly since a path-separator bug here would pass locally-on-Windows-by-luck and fail in CI, or vice versa.

## 5. Open questions

| # | Question | Who decides |
|---|---|---|
| 1 | Whether `db/schema.ts` may use `import type { ... } from '@/lib/schemas/...'` for jsonb column typing (this plan's reading of "no runtime import needed" in the ticket's File-scope note) or must avoid any `import` statement from `lib/schemas/**` entirely, using only prose comments (the stricter literal reading of "read/import only for type reference in comments"). §2.1 gives a one-line mechanical fallback either way. | Reviewer, at review time — low-stakes, does not affect any runtime behavior or test outcome either way. |
| 2 | Whether `userId`/`jobId` foreign keys should carry `onDelete: 'cascade'` (this plan's default, §2.1/§4) or no cascade action (relying entirely on PLT-01's explicit multi-table deletes). | Reviewer now (cheap to flip before any real data exists); re-confirm with Horace/PLT-01's Architect no later than PLT-01's own planning pass. |
| 3 | Whether `users.email` should carry `.unique()` (this plan's default, §2.1) — not in the ticket's literal Deliverable 1 column list, added because it matches the standard Auth.js Drizzle-adapter Postgres example and this app's expected sign-in-by-email flow. | FND-08's Builder, when actually wiring `DrizzleAdapter` — confirm the installed Auth.js version's adapter doesn't itself expect (or reject) a unique constraint on a differently-named column; revert this one line if it conflicts. |
| 4 | Whether `neon-http` (this plan's choice, §2.5) remains sufficient once PLT-01's hard account-delete needs real cross-table transactional atomicity, or whether that ticket should swap `db/index.ts` to `neon-serverless`. | PLT-01's Architect, at that ticket's planning time — not blocking for this ticket; flagged in §6 below as a hard-to-reverse-*ish* choice worth re-checking rather than assuming carries forward silently. |
| 5 | Whether Test-plan Tier 3 (pg-mem round-trip, §2.3) actually works against the real generated migration SQL — genuinely unknown until attempted; this plan gives a bounded-effort instruction (try it, drop it cleanly with a Deviations note if it doesn't pan out) rather than mandating success. | Builder, empirically, at build time — the outcome must be stated plainly in Deviations either way, since FND-06/FND-10's own Test plans explicitly key off it (§0). |

## 6. ADR-candidate flag

**Not proposing a new ADR file now — the ticket is explicit that none is needed** for the core "Drizzle + Neon Postgres, this table list" decision (already made in PRD §8.1/§5.6). This plan implements exactly what the ticket specifies for table shape.

Two sub-decisions inside this plan are **not** dictated by the ticket text and are the kind of thing a future ADR pass should be aware exists, even though this plan does not think either rises to "needs its own ADR file" today:

1. **Epoch-ms `bigint` vs. native Postgres `timestamp` for every `createdAt`/`updatedAt`/`deletedAt` column (§2.1).** This is a repo-wide convention every downstream query-helper ticket (FIT-01, TLR-01, PRP-04, PLT-01, PLT-02, PLT-04, plus FND-06/FND-10 inside this same module) inherits without re-deciding — switching it later would mean migrating every row and touching every query call site across every feature module, which is exactly the "hard to reverse" bar this pipeline's ADR guidance uses. This plan resolves it now (bigint epoch-ms) with strong textual evidence (the ticket's own Test-plan item 3 only type-checks against this choice — see §2.1) rather than leaving it for a later ticket to improvise inconsistently. Recorded as a decision-with-rationale in `01-foundation/README.md`'s changelog (§2.4) so it's discoverable without reading `db/schema.ts`'s inline comments — if a future ticket wants to revisit it, that written record is the trigger to write ADR-0002 (ADR-0001 slot is already reserved, per FND-04's plan §6, for the READ+CROSS+SCORE/RESEARCH+REHEARSE atomicity question).
2. **`neon-http` vs. `neon-serverless` driver choice (§2.5).** Lower-stakes than #1 because the `pg-core` schema/table definitions this ticket produces are driver-independent — swapping `db/index.ts`'s client construction later is mechanically contained to that one file, not a repo-wide migration. Still flagged (§5 Open Question #4) because the trade-off (no real interactive multi-statement transactions on `neon-http`) has a specific, foreseeable future trigger (PLT-01's hard-delete cascade) rather than being a purely theoretical concern — worth a named pointer so PLT-01's own Architect doesn't have to rediscover this trade-off from scratch.
