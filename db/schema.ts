import {
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

// Type-only references for jsonb column typing (`.$type<T>()`). These are erased
// by TypeScript at compile time (tsconfig `isolatedModules: true` requires the
// explicit `import type` form) — zero runtime coupling to lib/schemas/**, which
// is exactly what the ticket's File-scope note ("read/import only for type
// reference … no runtime import needed") asks for. Their only job is to make the
// jsonb columns' shapes compiler-checkable against their Zod counterparts, so the
// kind of drift the ticket's Feedback obligation #1 worries about surfaces at
// build time in this file rather than at runtime in a downstream query helper.
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

// -----------------------------------------------------------------------------
// Conventions for every future append to this file (FND-08 Auth.js tables,
// PLT-04 invite_codes, etc. — this file is append-only per breakdown-plan.md §3):
//
// 1. Timestamp columns are `bigint(..., { mode: 'number' })` holding epoch-ms
//    (JS `Date.now()`), NOT native Postgres `timestamp`. This mirrors every
//    FND-02/FND-04 Zod schema, whose timestamp-shaped fields are all `z.number()`
//    (epoch-ms), so a Zod-valid fixture round-trips through Drizzle with zero
//    conversion layer. The exceptions are `users.emailVerified`, `sessions.expires`,
//    and `verificationTokens.expires` (FND-08), which stay native `timestamp`
//    columns because their shape is dictated by the Auth.js Drizzle adapter
//    contract (JS `Date`), not this app's own Zod schemas. Do not "fix" those
//    exceptions for consistency — it would break FND-08's adapter wiring. Note
//    `accounts.expires_at` (FND-08) is a plain `integer` holding a raw OAuth2
//    token-expiry value in UNIX SECONDS (a third-party wire value), NOT one of this
//    app's own bigint-epoch-ms columns — do not "fix" it to bigint/ms either.
// 2. `updatedAt` columns use `.$onUpdate(() => Date.now())`. This callback runs
//    client-side in drizzle-orm at `.update()` time (not inside a DB lock), so
//    concurrent updates are last-write-wins on `updatedAt` — standard Postgres
//    MVCC behavior, not a new guarantee.
// 3. `jsonb` columns carry a `.$type<T>()` annotation for compile-time safety
//    only. Postgres validates "is valid JSON", NOT "matches the Zod shape" — Zod
//    validation at the application boundary remains the only runtime guarantee.
// 4. Every subsequent schema change must be captured by running `pnpm db:generate`
//    to produce a NEW migration file. Never hand-edit an existing
//    `db/migrations/*.sql` after the fact.
// -----------------------------------------------------------------------------

// --- Enums (defined once; reused where a table needs the same value set) ------

// matches lib/schemas/persisted.ts JobStatus
export const jobStatusEnum = pgEnum('job_status', [
  'screening',
  'applied',
  'interviewing',
  'closed',
]);

// matches lib/schemas/persisted.ts UsageOp — 'score' deliberately excluded, same
// reason as the Zod enum: SCORE is pure code, folded into the 'cross' usage event.
// Reused verbatim (not re-declared) for eval_runs.op below.
export const usageOpEnum = pgEnum('usage_op', [
  'parse',
  'read',
  'cross',
  'tailor',
  'research',
  'rehearse',
]);

// matches lib/schemas/persisted.ts EvalSuite
export const evalSuiteEnum = pgEnum('eval_suite', ['q1', 'q2', 'q3']);

// --- users --------------------------------------------------------------------
// Auth.js Drizzle-adapter-compatible base shape. FND-08 appends
// accounts/sessions/verificationTokens next to this table in the same file.
// `.unique()` on email and the uuid `id` default follow the Auth.js Drizzle
// adapter Postgres example convention.
export const users = pgTable('users', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text('name'),
  email: text('email').notNull().unique(),
  emailVerified: timestamp('email_verified', { mode: 'date' }),
  image: text('image'),
});

// --- libraries ----------------------------------------------------------------
// User-scoped via `userId`. `deletedAt` (nullable) is the soft-delete column per
// PRD §5.6 ("删除为软删防手滑") — it exists on THIS table only, not any other.
export const libraries = pgTable(
  'libraries',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
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

// --- resumes ------------------------------------------------------------------
// No file/blob columns: originals are discarded after parse (PRD §8.1). No
// createdAt — matches Resume's own Zod shape ({ sourceMd, updatedAt }).
export const resumes = pgTable(
  'resumes',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
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

// --- jobs ---------------------------------------------------------------------
// `jd`/`ledger`/`fit` are NOT NULL with no default — the DB-level mirror of
// FND-04's Job atomicity guarantee (a Job only exists once READ+CROSS+SCORE have
// produced all three). Do not relax without the escalation path FND-04's
// Feedback obligation #2 specifies.
export const jobs = pgTable(
  'jobs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
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

// --- tailored_resumes ---------------------------------------------------------
// No direct `userId` column — user-scoping happens by joining through
// `jobs.userId` (PRD §8.3 "无跨用户查询路径"). Every downstream query helper that
// touches this table MUST join through `jobs` to enforce isolation; Postgres
// cannot enforce "always join through jobs" declaratively.
export const tailoredResumes = pgTable(
  'tailored_resumes',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
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

// --- briefs -------------------------------------------------------------------
// `intel` nullable (RESEARCH may fail — P3 "degrade, don't block") / `rehearse`
// required (REHEARSE failure errors out) mirrors Brief's Zod-level asymmetry.
export const briefs = pgTable(
  'briefs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
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

// --- usage_events -------------------------------------------------------------
// Append-only cost/latency ledger (no updatedAt). The composite index on
// (userId, op, createdAt) is what FND-06's quota/breaker COUNT/SUM queries and
// PLT-03's admin aggregation both scan by.
export const usageEvents = pgTable(
  'usage_events',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
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
    index('usage_events_user_op_created_idx').on(
      table.userId,
      table.op,
      table.createdAt,
    ),
  ],
);

// --- eval_runs ----------------------------------------------------------------
// Quality-gate report row. `op` reuses the same pg enum type as usage_events.op.
export const evalRuns = pgTable('eval_runs', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  suite: evalSuiteEnum('suite').notNull(),
  op: usageOpEnum('op').notNull(),
  passRate: numeric('pass_rate', { mode: 'number' }).notNull(),
  details: jsonb('details').notNull().$type<Record<string, unknown>>(),
  createdAt: bigint('created_at', { mode: 'number' })
    .notNull()
    .$defaultFn(() => Date.now()),
});

// --- accounts / sessions / verification_tokens (Auth.js Drizzle-adapter tables) --
// Column shapes are dictated verbatim by @auth/drizzle-adapter's own Postgres
// reference schema (node_modules/@auth/drizzle-adapter/lib/pg — the
// DefaultPostgres*Table types) — do NOT rename any property (JS object key) here
// for camelCase/consistency with this file's other tables. DrizzleAdapter(db, {
// accountsTable: accounts, ... }) type-checks each table against those
// DefaultPostgres*Table types, which require these EXACT property names —
// including the snake_case-looking refresh_token / access_token / expires_at /
// token_type / id_token / session_state on accounts (those mirror OAuth2's own
// wire-format field names, not a style choice). A rename to camelCase produces a
// compile error at the DrizzleAdapter(...) call site, not a silent runtime bug.
// DB-level column-name strings (the first arg to text()/integer()/etc.) ARE free
// to follow this file's own snake_case convention; only the JS property keys are
// load-bearing. See this file's top-of-file convention comment (point 1) for why
// `expires` (sessions/verificationTokens) and `expires_at` (accounts) intentionally
// break the bigint-epoch-ms timestamp convention.

export const accounts = pgTable(
  'accounts',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type')
      .$type<'oauth' | 'oidc' | 'email' | 'webauthn'>()
      .notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.providerAccountId] }),
  ],
);

export const sessions = pgTable('sessions', {
  sessionToken: text('session_token').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { mode: 'date' }).notNull(),
});

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { mode: 'date' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.identifier, table.token] })],
);
