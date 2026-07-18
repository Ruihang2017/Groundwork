# Implementation plan — FND-10: Usage and cost observability recording helper

Ticket: [docs/prd/01-foundation/tickets/FND-10-usage-recording.md](../prd/01-foundation/tickets/FND-10-usage-recording.md)
Sub-PRD: [docs/prd/01-foundation/README.md](../prd/01-foundation/README.md)
Master spec: [docs/PRD.md](../PRD.md) §5.6 (`UsageEvent` code sketch), §8.4 ("记账：成本与延迟从第一天可观测…每次操作落 tokens / searches / cost / duration / dropped / stage 状态…不上 APM——一张表加一页汇总"), §9 ("成本结构与漏斗形状一致（P4）")
Depends on (merged): [docs/plans/FND-04.md](FND-04.md) / `lib/schemas/persisted.ts` (`UsageEvent`, `UsageOp`), [docs/plans/FND-05.md](FND-05.md) / `db/schema.ts` (`usageEvents` table + composite index), `db/index.ts` (`db` client, throws at import time without `DATABASE_URL`), the PGlite + `drizzle-orm/pglite` local-Postgres-substitute convention, [docs/plans/FND-06.md](FND-06.md) / `lib/config/pricing.ts` (`estimateCostUsd`, `PRICING`, `PricingModel`)
Downstream (read this plan's decisions before starting): LIB-01 (`op:'parse'`, no `droppedCount`), FIT-01 (`op:'read'`, no `droppedCount`), FIT-02 (`op:'cross'`, `droppedCount` = sum of validation-layer drops), TLR-01 (`op:'tailor'`, `droppedCount` = sum of two validation layers' drops), PRP-01 (`op:'research'`, `searches` = tool-use count, no `droppedCount`), PRP-02 (`op:'rehearse'`, `droppedCount` = one validation layer's drops), PLT-03 (reads `usage_events` including the two FND-10-added columns for admin aggregation)

This plan is cold-startable: a Builder with no access to the planning conversation can execute it from this file plus the ticket alone.

## 0. Repo-state check performed for this plan (do not re-derive, just confirm unchanged)

Verified at planning time (2026-07-18) by direct inspection, not assumption:

- `git log --oneline -1`: HEAD is `6a90ac4` (merge ticket/FND-09 into main), branch `main`, working tree clean. **`6a90ac4` is the base commit** the Builder's diff should be measured against.
- `lib/usage/` does not exist yet — this ticket creates it from scratch (`record.ts`, `record.test.ts`).
- `lib/schemas/persisted.ts` (FND-04, merged) exports `UsageEvent = z.object({ userId, op: UsageOp, tokensIn, tokensOut, searches, costUsd, durationMs, createdAt })` — **no `droppedCount`/`status` fields yet**. `UsageOp = z.enum(['parse','read','cross','tailor','research','rehearse'])` (six values, `'score'` deliberately excluded). Exact current line span of the `UsageEvent` block: lines 104–114 of `lib/schemas/persisted.ts`.
- `db/schema.ts` (FND-05, merged) exports `usageEvents` (pgTable `'usage_events'`) with columns `id, userId (FK→users.id, cascade), op (usageOpEnum, not null), tokensIn (integer), tokensOut (integer), searches (integer), costUsd (numeric, mode:'number'), durationMs (integer), createdAt (bigint, mode:'number', epoch-ms, $defaultFn)` and a composite index `usage_events_user_op_created_idx` on `(userId, op, createdAt)`. **No `droppedCount`/`status` columns yet.** Exact current line span: `usageEvents` table definition is lines 237–263; the `--- Enums ---` section (where `usageOpEnum`/`evalSuiteEnum` live) is lines 61–84.
- `db/index.ts` (FND-05, merged) exports `db` (a `drizzle-orm/neon-http` client) and **throws at import time** if `process.env.DATABASE_URL` is unset. This ticket's `record.ts` imports `db` from `@/db/index` the same way every other `lib/config/**` module does; `record.test.ts` must never let the real module load (mock it, per §2.6).
- `lib/config/pricing.ts` (FND-06, merged) exports `PRICING`, `PricingModel = 'sonnet5' | 'sonnet5PostIntro' | 'haiku45'`, and `estimateCostUsd({ model, tokensIn, tokensOut, searches }): number` — a **pure function with no throwing code path** in its current implementation (confirmed by direct read: plain arithmetic only, no divide-by-zero risk, no external I/O). `estimateCostUsd({ model: 'sonnet5', tokensIn: 100_000, tokensOut: 20_000, searches: 0 })` is hand-verified in `lib/config/pricing.test.ts` to equal exactly `0.4` — this plan's `record.test.ts` reuses that exact fixture for a cheap cross-check.
- `db/migrate.test.ts` (FND-05, merged) has a Tier-2 "committed migration SQL" describe block whose helper `readCommittedMigrationSql()` **concatenates every `.sql` file** under `db/migrations/` before regex-matching — appending a new migration file (§2.4 below) is additive to that joined string and cannot remove/alter any substring the existing Tier-2 assertions match against the original `0000_legal_pandemic.sql`/`0001_first_spiral.sql` content. Confirmed: none of Tier 2's regexes assert an *exhaustive* column list for `usage_events` (only `CREATE TABLE`, the three `jobs.*` `NOT NULL` checks, `briefs.intel` nullability, the composite index, and two FK-cascade checks) — none of those touch `usage_events`'s column set directly except the composite-index check, which is unaffected by adding unrelated columns. **No change needed to `db/migrate.test.ts`.**
- **`db/schema.test.ts` (FND-05, merged) DOES need a one-line change — this is the one necessary consequential edit beyond the ticket's literal File-scope list.** It has an exhaustive-column-set test (`'usage_events has exactly the expected columns (no more, no fewer)'`, sorting and `toEqual`-comparing `Object.keys(getTableColumns(usageEvents))` against a hardcoded `expectedColumns.usage_events` array — currently `['id','userId','op','tokensIn','tokensOut','searches','costUsd','durationMs','createdAt']`, line span 54–64). Appending `droppedCount`/`status` to the `usageEvents` table (Deliverable 1) without updating this array **will fail this pre-existing test**, breaking `pnpm test` (this ticket's own acceptance item 4, and the module's own `pnpm test` acceptance gate). The ticket's File-scope text authorizes appending to `db/schema.ts` itself ("if Deliverable 1 needs new columns, this ticket appends to `db/schema.ts` too, same justification as above" — i.e. FND-05 already merged, sequential, no in-flight contention) but does not literally name `db/schema.test.ts`; this plan treats keeping that file's own pre-existing assertion accurate as an unavoidable, minimal (two-line), same-justification consequential edit — not a scope expansion. See §4 for the explicit flag to the Reviewer.
- `lib/schemas/persisted.test.ts` (FND-04, merged) has a `validUsageEvent` fixture (line 136–145) with **no `droppedCount`/`status` keys** and asserts `UsageEvent.parse(validUsageEvent)` does not throw (line 283–285). Because both new Zod fields carry `.default(...)`, this fixture keeps parsing successfully **unmodified** — confirmed by Zod v4 semantics (`.default()` makes a field optional on the *input* type). **No change needed to `lib/schemas/persisted.test.ts`** (and the ticket's File-scope does not authorize touching it — only `persisted.ts` is named for append).
- `vitest.config.ts`'s `test.include` already contains `'lib/**/*.test.ts'` (widened by FND-02's writeback, reused by every subsequent `lib/**` ticket) — `lib/usage/record.test.ts` is already discovered by `pnpm test` with **no config change needed**.
- `package.json` already has `@electric-sql/pglite`, `drizzle-orm`, `drizzle-kit` available (FND-05) — **no new dependency needed** by this ticket.
- `.env.example` needs no change — this ticket introduces no new environment variable (unlike FND-06's `GLOBAL_DAILY_SPEND_LIMIT_USD`).
- **Load-bearing finding — no currently-drafted downstream caller ever passes `status: 'failure'`.** Direct grep of `docs/prd/03-library/`, `04-fit/`, `05-tailor/`, `06-prep/` ticket text: `LIB-01`'s parse route calls `recordUsage()` **only on success** (its unrecoverable-failure branch returns HTTP 422 directly, no `recordUsage()` call). `FIT-01`, `FIT-02`, `TLR-01`, `PRP-02` are the same shape — `recordUsage()` appears only in each handler's success tail, never in an error branch. `PRP-01`'s RESEARCH failure path is the closest case (it *does* still return `HTTP 200 { intel: null, failed: true }` per P3 degrade-not-block) but its own ticket text still only calls `recordUsage()` "on success" (line 49(g)), not on that degraded path either. **This means PRD §8.4's literal ask ("每次操作落…dropped / stage 状态") is not yet fulfilled end-to-end** — this ticket supplies the `status` field and the ability to record a failed operation, but no currently-drafted downstream ticket exercises `status: 'failure'`. Flagged in §5 as an open question for those six tickets' own Architect passes / Horace, not something this ticket can or should fix (Non-goals: no per-route wiring).
- `docs/prd/05-tailor/tickets/TLR-01-tailor-route.md` and `docs/prd/06-prep/tickets/PRP-02-rehearse-route.md` both already reference `droppedCount` as a plain **summed number** passed into `recordUsage()` (e.g. TLR-01: "`droppedCount` = sum of (g)+(h)'s dropped counts") — confirms `droppedCount?: number` (not an array) is the right shape, and that `lib/validation/referential-integrity.ts` / `number-integrity.ts`'s own `dropped: Array<...>` return values are summed by the *caller* (`.length`, or summed across layers) before reaching `recordUsage()` — this ticket's Non-goals ("No dropped-count computation") is consistent with what's actually drafted downstream.

## 1. Scope

**In scope** (per ticket Deliverables 1–3, File-scope, plus the one necessary consequential edit identified in §0):

- Append `droppedCount`/`status` to `UsageEvent` in `lib/schemas/persisted.ts` (Deliverable 1, Zod side).
- Append a new `usageEventStatusEnum` pg enum + `droppedCount`/`status` columns to the `usageEvents` table in `db/schema.ts` (Deliverable 1, Drizzle side).
- Regenerate the Drizzle migration (`pnpm db:generate`) to capture that schema change — a new, tool-generated `.sql` file under `db/migrations/` plus its `meta/*.json` snapshot/journal entries. **Never hand-write migration SQL.**
- One necessary two-line edit to `db/schema.test.ts`'s `expectedColumns.usage_events` array (§0, §4) so its pre-existing exhaustive-column assertion keeps matching reality.
- New file `lib/usage/record.ts` — `recordUsage()` (Deliverable 2), computing `costUsd` via FND-06's `estimateCostUsd`, defaulting `droppedCount`/`status`, and swallowing its own insert failure (Deliverable 3).
- New file `lib/usage/record.test.ts` — unit/integration tests for the above.

**Explicitly out of scope** (per ticket Non-goals — do not implement, even opportunistically):

- No quota/breaker checking (FND-06's job, already merged; `recordUsage()` never calls `checkAndIncrementQuota`/`checkGlobalBreaker`).
- No `/admin` aggregation queries — `07-platform-launch`/PLT-03's job.
- No dropped-count *computation* — `recordUsage()` accepts a caller-supplied `droppedCount: number`, never inspects `lib/validation/**`'s own `dropped: Array<...>` shapes itself.
- No per-route wiring — no edits to any `app/api/**` route (LIB-01/FIT-01/FIT-02/TLR-01/PRP-01/PRP-02 are each their own ticket's job).
- No resolution of the "no downstream ticket currently calls `status: 'failure'`" gap identified in §0 — flagged as an open question (§5), not fixed here.
- No date-based automatic switching between `PRICING.sonnet5`/`sonnet5PostIntro` inside `recordUsage()` — this plan hardcodes `'sonnet5'` explicitly (§2.5), consistent with FND-06's own Feedback obligation #1 ("no silent date-branching"); flagged as an open question (§5), not resolved here.
- No edits to `lib/config/**` (FND-06, read/import only) or to `db/index.ts` (FND-05, read/import only).

## 2. Change list

### 2.1 `lib/schemas/persisted.ts` — append `droppedCount`/`status` to `UsageEvent`

Edit the existing `UsageEvent` block (current lines 104–114) — insert two new fields immediately after the existing `createdAt` line, before the closing `});`. Do not reorder or touch any other field.

```ts
export const UsageEvent = z.object({
  userId: z.string(),
  op: UsageOp,
  tokensIn: z.number(),
  tokensOut: z.number(),
  searches: z.number(),
  costUsd: z.number(),
  durationMs: z.number(),
  createdAt: z.number(), // FND-04 extension (FND-06 daily-window quota queries)
  // --- FND-10 extension ---------------------------------------------------
  // Added by FND-10 to satisfy PRD §8.4's "dropped / stage 状态" logging
  // requirement, absent from §5.6's literal code sketch (§5.6's UsageEvent
  // code block above lists only tokensIn/tokensOut/searches/costUsd/
  // durationMs). This is a genuine gap between §5.6's code sketch and §8.4's
  // prose, resolved here per the FND-10 ticket's own Deliverable 1 decision
  // rather than silently favoring one PRD section over the other. Both
  // default so every pre-FND-10 UsageEvent fixture (e.g.
  // lib/schemas/persisted.test.ts's validUsageEvent) keeps parsing
  // unmodified — see db/schema.ts's usageEventStatusEnum comment for the
  // mirrored Drizzle-side note.
  droppedCount: z.number().default(0),
  status: z.enum(['success', 'failure']).default('success'),
});
export type UsageEvent = z.infer<typeof UsageEvent>;
```

No other line in this file changes. `lib/schemas/persisted.test.ts` is intentionally **not** touched (§0) — it is outside this ticket's File-scope and its existing `validUsageEvent` fixture continues to pass unmodified because of the `.default(...)` calls above.

### 2.2 `db/schema.ts` — append `usageEventStatusEnum` + two columns to `usageEvents`

Two separate insertions, both additive (do not reorder existing lines):

**(a)** In the `--- Enums ---` section, immediately after the existing `evalSuiteEnum` declaration (current line 84), before the `--- users ---` comment (current line 86):

```ts
// FND-10 extension — matches lib/schemas/persisted.ts's UsageEvent.status
// field. Added by FND-10 to satisfy PRD §8.4's "dropped / stage 状态"
// logging requirement, absent from §5.6's literal code sketch. Not reused by
// any other table (unlike usageOpEnum, which eval_runs.op also uses).
export const usageEventStatusEnum = pgEnum('usage_event_status', ['success', 'failure']);
```

**(b)** In the `usageEvents` table definition (current lines 237–263), immediately after the existing `createdAt` column (current lines 252–254), before the closing `},` that starts the index-array second argument (current line 255):

```ts
    // FND-10 extension (see usageEventStatusEnum above + lib/schemas/
    // persisted.ts's UsageEvent for the parallel Zod-side note). Both
    // NOT NULL with a DB-level default so FND-05's own pre-existing
    // db/migrate.test.ts Tier-3 insert (written before this extension
    // existed, and not updated to supply these two columns — see §0) keeps
    // round-tripping unmodified.
    droppedCount: integer('dropped_count').notNull().default(0),
    status: usageEventStatusEnum('status').notNull().default('success'),
```

No new imports are required in this file — `pgEnum` and `integer` are already imported at the top (used by `jobStatusEnum`/`usageOpEnum`/`evalSuiteEnum` and `tokensIn`/`tokensOut`/`searches`/`durationMs` respectively).

### 2.3 `db/schema.test.ts` — necessary consequential edit (two lines)

In `expectedColumns.usage_events` (current lines 54–64), append the two new column names so the file's own pre-existing "exactly the expected columns (no more, no fewer)" test keeps matching reality:

```ts
  usage_events: [
    'id',
    'userId',
    'op',
    'tokensIn',
    'tokensOut',
    'searches',
    'costUsd',
    'durationMs',
    'createdAt',
    'droppedCount', // FND-10 extension
    'status', // FND-10 extension
  ],
```

Recommended (not mandatory — the acceptance checklist does not require it, but it matches this file's existing rigor for every other enum column) bonus coverage in the same file's `'db/schema — pg enums'` describe block:

```ts
it('usageEventStatusEnum has exactly success/failure', () => {
  expect(usageEventStatusEnum.enumValues).toEqual(['success', 'failure']);
});

it('usage_events.status uses the usageEventStatusEnum pg enum type', () => {
  expect(getTableColumns(usageEvents).status.enumValues).toEqual(usageEventStatusEnum.enumValues);
});
```

(requires adding `usageEventStatusEnum` to the file's existing `@/db/schema` import list). Do not touch `db/migrate.test.ts` — confirmed unnecessary in §0.

### 2.4 Regenerate the migration (mechanical — run, do not hand-write)

After 2.1–2.2 are in place, from the repo root:

```
pnpm db:generate
```

This runs `drizzle-kit generate` (already proven to work fully offline — no `DATABASE_URL` needed, confirmed by `db/migrate.test.ts`'s own Tier-1 test and `drizzle.config.ts`'s `url: process.env.DATABASE_URL ?? ''` fallback). It diffs the edited `db/schema.ts` against `db/migrations/meta/0001_snapshot.json` and emits a new `000X_<generated-name>.sql` (drizzle-kit auto-names it), plus a new `meta/000X_snapshot.json` and an appended entry in `meta/_journal.json`. Expect the generated SQL to contain roughly: a `CREATE TYPE "usage_event_status" AS ENUM ('success', 'failure')` statement and two `ALTER TABLE "usage_events" ADD COLUMN "dropped_count" integer DEFAULT 0 NOT NULL` / `ADD COLUMN "status" "usage_event_status" DEFAULT 'success' NOT NULL` statements. **Never hand-edit an existing `db/migrations/*.sql` file** (repo-wide convention, stated in `db/schema.ts`'s own top-of-file comment, point 4). Commit the three newly-generated files (`.sql`, `meta/000X_snapshot.json`, updated `meta/_journal.json`) as-is.

### 2.5 `lib/usage/record.ts` (new file)

```ts
import { db } from '@/db/index';
import { usageEvents } from '@/db/schema';
import { estimateCostUsd } from '@/lib/config/pricing';
import type { UsageOp } from '@/lib/schemas/persisted';

// PRD §5.6/§8.4: the single write-path every stage-owning route (LIB-01,
// FIT-01, FIT-02, TLR-01, PRP-01, PRP-02) calls once per user-facing
// operation, after that operation completes, to persist one usage_events
// row. See the FND-10 ticket's Background for why this is ONE row per
// user-facing action, not per internal LLM call (e.g. FIT-01 records
// op:'read' and FIT-02 later separately records op:'cross' for one
// completed Fit) — this function has no opinion on that; it writes exactly
// the one row its caller asks for, once, and does not call UsageEvent.parse
// on its input (this is an internal trusted write path downstream of
// FND-07's four validation layers, not a request-body boundary).

export type RecordUsageEvent = {
  userId: string;
  op: UsageOp;
  tokensIn: number;
  tokensOut: number;
  searches: number;
  durationMs: number;
  droppedCount?: number;
  status?: 'success' | 'failure';
};

// Hardcoded to the PRE-8/31 intro Sonnet rate. Every currently-drafted
// caller of recordUsage() (LIB-01/FIT-01/FIT-02/TLR-01/PRP-01/PRP-02) calls
// PRIMARY_MODEL ('claude-sonnet-5', lib/config/models.ts) exclusively —
// JUDGE_MODEL ('claude-haiku-4-5') is only used by 02-evaluation's
// not-yet-built judge harness, which this ticket's Goal does not list as a
// recordUsage() caller. This is an explicit, non-calendar-computed choice
// (lib/config/pricing.ts's own Feedback obligation #1 forbids silent
// date-branching) — NOT automatically resolved from Date.now(). See the
// plan's Open Questions: if recordUsage() ever needs to price a non-sonnet5
// call, or needs to flip to 'sonnet5PostIntro' after 2026-08-31, this
// function's signature has no `model` parameter to receive that (literal
// per the ticket's own Deliverable 2 text) — that is a signature change to
// make deliberately, not a silent internal fix.
const RECORD_USAGE_PRICING_MODEL = 'sonnet5' as const;

export async function recordUsage(event: RecordUsageEvent): Promise<void> {
  // Deliberately OUTSIDE the try/catch below: estimateCostUsd is a pure
  // function over four numeric inputs with no throwing code path in its
  // current implementation (lib/config/pricing.ts, verified by direct read
  // at planning time) — only the DB write itself is the failure mode
  // Deliverable 3 asks this function to swallow.
  const costUsd = estimateCostUsd({
    model: RECORD_USAGE_PRICING_MODEL,
    tokensIn: event.tokensIn,
    tokensOut: event.tokensOut,
    searches: event.searches,
  });

  try {
    await db.insert(usageEvents).values({
      userId: event.userId,
      op: event.op,
      tokensIn: event.tokensIn,
      tokensOut: event.tokensOut,
      searches: event.searches,
      costUsd,
      durationMs: event.durationMs,
      droppedCount: event.droppedCount ?? 0,
      status: event.status ?? 'success',
    });
  } catch (err) {
    // PRD §8.4 explicitly rejects standing up an APM ("不上 APM") —
    // console.error is the entire error-observability budget for this path.
    // A usage-logging outage must never fail the parent request (ticket
    // Deliverable 3; this repo's P3 "degrade, don't block" spirit applied to
    // observability logging, an explicit extension documented here per the
    // ticket's own instruction, since P3 is literally scoped to RESEARCH).
    console.error('[recordUsage] failed to write a usage_events row', {
      userId: event.userId,
      op: event.op,
      err,
    });
  }
}
```

Notes for the Builder:

- `RecordUsageEvent` is exported (a minor, additive design choice by this plan, not literally requested by the ticket) so `record.test.ts` can reference the exact parameter type for its type-escape test (§2.6) without duplicating it — matches this repo's existing convention of exporting small helper types (e.g. `lib/config/quota.ts`'s `QuotaOp`).
- Do not add a `model` parameter "to be safe" — the ticket's Deliverable 2 signature is literal; adding one is a scope expansion this plan does not authorize (flagged instead as an open question, §5).
- Do not run the input through `UsageEvent.parse(...)` — `UsageEvent` (2.1) includes `costUsd`/`createdAt`, neither of which `RecordUsageEvent` accepts as input (both are computed/defaulted here or by the DB), so parsing would require constructing a throwaway object first; this function constructs the Drizzle insert directly instead.

### 2.6 `lib/usage/record.test.ts` (new file)

`record.ts` imports the real `db` from `@/db/index`, which throws at import time without `DATABASE_URL` — identical constraint to `lib/config/quota.ts` (FND-06). Never statically import `record.ts`; always `vi.doMock('@/db/index', ...)` + `vi.resetModules()` + dynamic `import()` after the mock is in place, per the pattern already established in `lib/config/quota.test.ts`.

Two describe blocks, two different `db` substitutes:

**Happy-path block** — one shared PGlite instance (`beforeAll`), migrated via the real committed `db/migrations/**` (now including §2.4's new migration) through `drizzle-orm/pglite/migrator`. Each `it()` uses a fresh `crypto.randomUUID()` `userId` (seeded into `users` first, satisfying the FK) for isolation, mirroring `quota.test.ts`'s `checkAndIncrementQuota` block.

**Failure-swallowing block** — a hand-built fake `db` whose `insert(...).values(...)` rejects, so no PGlite/migration is needed there at all.

```ts
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { estimateCostUsd } from '@/lib/config/pricing';
import type { RecordUsageEvent } from '@/lib/usage/record';

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

async function createTestDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './db/migrations' });
  return db;
}

async function seedUser(db: TestDb, userId: string) {
  await db.insert(schema.users).values({ id: userId, email: `${userId}@example.com` });
}

async function readRow(db: TestDb, userId: string) {
  const [row] = await db.select().from(schema.usageEvents).where(eq(schema.usageEvents.userId, userId));
  return row;
}

describe('recordUsage — happy path (PGlite-backed real insert)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    vi.resetModules();
    vi.doMock('@/db/index', () => ({ db }));
  });

  function importRecord() {
    return import('@/lib/usage/record');
  }

  // [acceptance item 1, part 1] costUsd is computed via estimateCostUsd,
  // reusing pricing.test.ts's own hand-verified sonnet5 example.
  it('computes costUsd via estimateCostUsd(sonnet5) from tokensIn/tokensOut/searches', async () => {
    const { recordUsage } = await importRecord();
    const userId = crypto.randomUUID();
    await seedUser(db, userId);

    await recordUsage({
      userId, op: 'read', tokensIn: 100_000, tokensOut: 20_000, searches: 0, durationMs: 1500,
    });

    const row = await readRow(db, userId);
    expect(row.costUsd).toBe(0.4);
    expect(row.op).toBe('read');
    expect(row.durationMs).toBe(1500);
  });

  // [acceptance item 2]
  it('defaults droppedCount:0 and status:"success" when omitted', async () => {
    const { recordUsage } = await importRecord();
    const userId = crypto.randomUUID();
    await seedUser(db, userId);

    await recordUsage({ userId, op: 'tailor', tokensIn: 1, tokensOut: 1, searches: 0, durationMs: 1 });

    const row = await readRow(db, userId);
    expect(row.droppedCount).toBe(0);
    expect(row.status).toBe('success');
  });

  // supplementary — proves explicit values pass through, not just defaults.
  it('forwards explicit droppedCount/status when provided', async () => {
    const { recordUsage } = await importRecord();
    const userId = crypto.randomUUID();
    await seedUser(db, userId);

    await recordUsage({
      userId, op: 'cross', tokensIn: 1, tokensOut: 1, searches: 0, durationMs: 1,
      droppedCount: 3, status: 'failure',
    });

    const row = await readRow(db, userId);
    expect(row.droppedCount).toBe(3);
    expect(row.status).toBe('failure');
  });

  // [acceptance item 1, part 2 — load-bearing] a caller cannot override
  // costUsd even by smuggling an extra property past TypeScript via a type
  // escape — the production code path always recomputes it.
  it('ignores a smuggled costUsd field and recomputes cost instead', async () => {
    const { recordUsage } = await importRecord();
    const userId = crypto.randomUUID();
    await seedUser(db, userId);

    const smuggled = {
      userId, op: 'tailor', tokensIn: 100_000, tokensOut: 20_000, searches: 0, durationMs: 1,
      costUsd: 999_999, // NOT part of RecordUsageEvent — smuggled via the cast below
    } as unknown as RecordUsageEvent;

    await recordUsage(smuggled);

    const row = await readRow(db, userId);
    const expectedCost = estimateCostUsd({ model: 'sonnet5', tokensIn: 100_000, tokensOut: 20_000, searches: 0 });
    expect(row.costUsd).toBe(expectedCost);
    expect(row.costUsd).not.toBe(999_999);
  });
});

describe('recordUsage — DB-insert failure is swallowed, not re-thrown', () => {
  // [acceptance item 3 — load-bearing]
  it('resolves (does not reject) when the insert rejects, and logs via console.error', async () => {
    vi.resetModules();
    const insertError = new Error('simulated insert failure');
    const fakeDb = { insert: () => ({ values: () => Promise.reject(insertError) }) };
    vi.doMock('@/db/index', () => ({ db: fakeDb }));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { recordUsage } = await import('@/lib/usage/record');

    await expect(
      recordUsage({ userId: 'u1', op: 'parse', tokensIn: 1, tokensOut: 1, searches: 0, durationMs: 1 }),
    ).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
```

Optional, supplementary (not `pnpm test`-verified — only caught by `pnpm build`'s `tsc` pass over the whole project, since `tsconfig.json`'s `include` covers `**/*.ts` including test files, and Vitest's own esbuild transform does not type-check): a `// @ts-expect-error` compile-time guard directly above a call that passes `costUsd` as a literal object property (excess-property check), as a second, cheaper proof that the *type* also rejects it. If added, comment clearly that this assertion is validated by `pnpm build`, not `pnpm test`, so its coverage isn't mistakenly assumed to show up in Vitest's run.

## 3. Test plan

Maps to the ticket's acceptance checklist:

1. `record.test.ts`'s "computes costUsd via estimateCostUsd" + "ignores a smuggled costUsd field" cases together prove acceptance item 1 (`costUsd` computed via `estimateCostUsd`, never caller-supplied) — the first proves the happy path computes the right number; the second proves the function actively resists an attempted override even when TypeScript is bypassed, which is the load-bearing half of "not a caller-supplied value."
2. `record.test.ts`'s "defaults droppedCount:0 and status:'success'" case proves acceptance item 2.
3. `record.test.ts`'s "resolves … and logs via console.error" case proves acceptance item 3 (both halves: does not reject, and does log).
4. `pnpm test` exits 0 overall (acceptance item 4) — including every pre-existing suite (`tests/**`, `lib/**`, `db/**`) unaffected, `db/schema.test.ts`'s updated `expectedColumns.usage_events` (§2.3) still passing, `db/migrate.test.ts`'s Tier 1–3 still passing (§0's reasoning), plus the two new `lib/usage/*.test.ts` files actually discovered (already covered by the existing `lib/**/*.test.ts` glob — explicitly check the run output lists them, per this repo's established "don't let a glob miss create a false green" discipline).
5. `pnpm db:generate` (§2.4) exits 0 and the resulting migration is committed — verify by re-running `pnpm test` afterward (`db/migrate.test.ts`'s Tier 1 independently regenerates into a scratch dir and would itself catch a schema/generator regression).
6. `pnpm build` once, after all files are complete — cheap insurance beyond Vitest's non-typechecking transpile (same discipline as FND-06's plan), and the only way the optional `@ts-expect-error` guard (§2.6) gets validated at all.
7. `git diff --stat 6a90ac4..HEAD` (base commit confirmed in §0) should list exactly: `lib/schemas/persisted.ts`, `db/schema.ts`, `db/schema.test.ts`, one new `db/migrations/000X_*.sql` + its `meta/000X_snapshot.json` + updated `meta/_journal.json`, `lib/usage/record.ts`, `lib/usage/record.test.ts`. Anything else (in particular any edit inside `lib/config/**`, `db/index.ts`, `lib/schemas/persisted.test.ts`, `db/migrate.test.ts`, `vitest.config.ts`, or `.env.example`) is a File-scope violation and must be reverted before merge.
8. Everything above is reproducible fully offline — no live `DATABASE_URL`, no live Anthropic API calls. The happy-path tests exercise `@/db/index` only via the PGlite mock; the failure-swallowing test uses a hand-built stub, never the real module.

## 4. Risks & edge cases

- **Concurrency: none of note.** Unlike FND-06's `checkAndIncrementQuota` (a read-then-write race), `recordUsage()` is a single, independent `INSERT` per call with no read-modify-write step — Postgres (and PGlite in tests) natively serializes concurrent inserts into the same table without any additional locking needed here. Two simultaneous `recordUsage()` calls for the same user simply produce two independent rows; there is no shared mutable state inside this function for a race to corrupt. Explicitly called out per this repo's `CLAUDE.md` reviewer-focus instruction, so this is a considered "no risk," not a silently-skipped box.
- **Security-sensitive path: `recordUsage(event)` trusts its caller for `event.userId`'s authenticity — it performs no authentication itself**, and (per §2.5's design note) does not validate its input via `UsageEvent.parse(...)` either. It writes whatever `userId`/`op`/counts it is given. This is consistent with FND-06's `checkAndIncrementQuota` precedent (same trust boundary, same repo-wide pattern: `requireUserId()` (FND-08) is the actual auth boundary, upstream in each stage route) — every call site (LIB-01, FIT-01, FIT-02, TLR-01, PRP-01, PRP-02) is expected to pass a session-derived `userId`, never a client-supplied one (PRD §8.3 "无跨用户查询路径"). A caller passing a bogus/nonexistent `userId` (FK violation against `users.id`) would hit this function's own catch block and be silently swallowed with a `console.error` — same intended behavior as any other insert failure (Deliverable 3), not a special case, but worth naming explicitly: a broken `userId` upstream produces a silently-dropped usage row, not a loud failure, by design.
- **The `status: 'failure'` gap (§0's load-bearing finding).** This ticket's own Deliverable 1 adds a `status` field specifically because PRD §8.4 asks every operation's "stage 状态" to be logged — but as of this plan, no downstream ticket (LIB-01/FIT-01/FIT-02/TLR-01/PRP-01/PRP-02, all currently drafted) actually calls `recordUsage()` on a failure path; every one calls it only in its success tail. This means PRD §8.4's literal ask is only half-satisfied by the pipeline as currently specified — the *capability* exists (this ticket), the *usage* of it does not yet (those six tickets). This is explicitly out of this ticket's Non-goals ("no per-route wiring") to fix, but is surfaced here prominently (and in §5) so it is not lost — the Reviewer should confirm this plan correctly declines to fix it locally (per the ticket's Feedback obligation #1, a design-fit question for each downstream ticket, escalated rather than silently worked around here).
- **`RECORD_USAGE_PRICING_MODEL` hardcoded to `'sonnet5'` (§2.5).** Two forward risks, both flagged as open questions (§5) rather than fixed here: (a) after 2026-08-31 (PRD's own named cutover date), any `recordUsage()` call still implicitly uses the intro rate and under-reports actual cost by 50% — `recordUsage()`'s signature has no `model` parameter to receive `'sonnet5PostIntro'` (literal per the ticket's Deliverable 2 text), so fixing this requires a deliberate signature change, not a silent internal date-check; (b) if `02-evaluation`/EVL-02 ever routes judge-model (`haiku45`) cost tracking through this same `recordUsage()` (as `lib/config/pricing.ts`'s own doc-comment speculates it might, "indirectly, via FND-10"), every such call would be mispriced at Sonnet rates — this ticket's Goal section does not list EVL-02 as a caller, so this plan does not accommodate it, but the mismatch between that speculative doc-comment and this ticket's literal, caller-agnostic signature is worth the Reviewer's attention.
- **Migration-generation safety for the new columns.** Both `droppedCount`/`status` are added as `NOT NULL` with a DB-level `DEFAULT` (§2.2), which Postgres can apply to a table with pre-existing rows without a separate backfill step (unlike a `NOT NULL` column with no default, which would fail against existing rows). No live Neon database is provisioned yet (`01-foundation/README.md`'s open question #2, unchanged), so there is no real data at risk in practice — this note is forward-looking documentation for when Horace does provision one and runs `pnpm db:migrate` for the first time against real (eventually non-empty) data.
- **No rounding on `costUsd`** — inherited unchanged from FND-06's `estimateCostUsd` (already flagged in that ticket's own plan); `recordUsage()` does not add or remove any rounding behavior.
- **Windows/cross-platform**: this plan reuses FND-05/FND-06's already-proven-cross-platform PGlite + `drizzle-orm/pglite` test infrastructure (same dev machine, same pattern) — no new platform-specific risk.

## 5. Open questions

| # | Question | Who decides |
|---|---|---|
| 1 | Whether `LIB-01`/`FIT-01`/`FIT-02`/`TLR-01`/`PRP-01`/`PRP-02` should be updated to call `recordUsage({ ..., status: 'failure' })` on their error/degraded paths, so PRD §8.4's "dropped / stage 状态" logging requirement is actually fulfilled end-to-end (§0, §4) — currently none of their drafted ticket text does this. | Each of those six tickets' own Architect pass (re-confirm against this ticket's merged `record.ts` before building), or Horace if it's a product-policy call (e.g. "do failed attempts even need a spend-adjacent audit row, given they usually cost ~$0 anyway since most 4xx paths in those tickets fail *before* the paid call"). |
| 2 | Whether `recordUsage()` should eventually accept an explicit `model` parameter (rather than hardcoding `'sonnet5'`), to (a) auto-correct after the 2026-08-31 pricing cutover and (b) support a future judge-cost-tracking caller (EVL-02) without mispricing. | Horace — this plan deliberately does not add the parameter (ticket's Deliverable 2 signature is literal, and FND-06's Feedback obligation #1 forbids silent date-branching); flag before `02-evaluation`/EVL-02 is planned if that ticket turns out to need judge-cost tracking through this function. |
| 3 | Whether the Sonnet 5 intro/post-8-31 price cutover should be automated at all (carried over verbatim from FND-06's own open question #3 — unchanged by this ticket, restated here because `recordUsage()` is the first and only current call site of `estimateCostUsd`). | Horace. |
| 4 | Whether the recommended-but-optional `db/schema.test.ts` bonus coverage for `usageEventStatusEnum` (§2.3) should be added. | Builder, at build time (low-stakes either way). |

## 6. ADR-candidate flag

**Not proposing a new ADR.** The ticket header is explicit that none is needed (PRD §5.6/§8.4 already decide the shape and intent). The one genuinely new decision this ticket's own text makes — extending `UsageEvent`/`usage_events` with `droppedCount`/`status` to resolve the §5.6-vs-§8.4 gap — is the ticket's *own* Deliverable 1 decision, not a decision this plan is introducing; it is a small, purely additive, easily-reversible schema extension (two nullable-by-default columns), not a hard-to-reverse architectural choice. This plan's own contributions beyond the ticket's literal text — hardcoding `RECORD_USAGE_PRICING_MODEL = 'sonnet5'` and the `db/schema.test.ts` consequential edit — are both single-file, low-blast-radius, well-documented, and explicitly flagged as open questions/risks (§4, §5) rather than buried; neither rises to ADR weight.
