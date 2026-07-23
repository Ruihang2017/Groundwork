# PLT-03 — Implementation Plan

`/admin` observability page: weekly cost, p50/p95 latency, dropped rate, and the three PRD §7 funnel-conversion ratios, behind an env-var email allowlist.

Ticket: `docs/prd/07-platform-launch/tickets/PLT-03-admin-observability.md`
Sub-PRD: `docs/prd/07-platform-launch/README.md` (open question #1 — admin-auth mechanism)
Master spec: `docs/PRD.md` §7 (metrics table, lines 205–217), §8.4 (line 262, observability policy), §8.3, §3 C5, §10 P5
Depends on (merged): FND-08 (`auth.ts`, `auth.config.ts`, `middleware.ts`, `lib/auth/session.ts`), FND-10 (`lib/usage/record.ts`, the `usage_events.droppedCount`/`status` columns), FND-05 (`db/schema.ts`, `db/index.ts`, `db/migrations/**`)
No ADR file exists in this repo yet (`docs/adr/` is empty). §2.1 flags the one ADR candidate this ticket contains.

This plan was produced by reading the ticket, the sub-PRD, `docs/prd/breakdown-plan.md` §3, `docs/plans/PLT-01.md`, `docs/plans/FND-08.md`-derived code, and the *current merged state* of `middleware.ts`, `middleware.test.ts`, `auth.ts`, `auth.config.ts`, `app/layout.tsx`, `app/(app)/settings/page.tsx` (+ its test), `app/(legal)/privacy/page.test.tsx`, `db/schema.ts`, `db/migrations/**`, `lib/usage/record.ts`, `lib/db/queries/library.ts` (+ its test), `app/api/account/delete/route.test.ts`, `lib/schemas/persisted.ts`, `eval/assertions/q1.ts`, `vitest.config.ts`, `package.json`, `.env.example`.

## 0. Facts verified at planning time (do not re-derive; do not assume the opposite)

Each of these was checked directly against the installed source or an executed probe, not inferred:

1. **`drizzle-orm`'s `sum()` maps its result to a STRING.** `node_modules/drizzle-orm/sql/functions/aggregate.js` line 17: ``sum(expression) { return sql`sum(${expression})`.mapWith(String); }``, typed `SQL<string | null>` (`aggregate.d.ts:69`). `count()`/`countDistinct()` *do* map with `Number` (same file, lines 4–8). **Consequence: every `sum()` result must be `Number(...)`-coerced by hand; every `count()` result is already a number.** A NULL is preserved as `null` (not `"null"`) — `node_modules/drizzle-orm/utils.js:30` reads ``rawValue === null ? null : decoder.mapFromDriverValue(rawValue)`` — so `Number(row.total ?? 0)` is correct and safe.
2. **PGlite (this repo's test substrate) supports ordered-set aggregates.** Executed probe: `percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)` and `percentile_disc` both work, return JS `number`. For durations `[10, 20, 30, 40]`: `percentile_cont` → p50 `25`, p95 `38.5`; `percentile_disc` → p50 `20`, p95 `40`. For a single value `[100]`: both percentiles → `100`.
3. **Raw `SUM(numeric)` comes back from PGlite as the string `"0.20"`; `COUNT(*)` and `SUM(integer)` come back as numbers.** Postgres returns `count`/`sum(int)` as `bigint`, which node-postgres/neon-http parse as **strings** while PGlite parses them as numbers. This driver disagreement is real; it is fully neutralised by fact 1 (drizzle's own `mapWith`) *plus* the "coerce with `Number()` at the boundary" rule in §2.3 — do not rely on the driver's native mapping anywhere.
4. **An empty window returns `SUM(...) = NULL` and `COUNT(*) = 0`; a `GROUP BY op` over an empty set returns zero rows** (not rows of zeros). Probe-confirmed. So `getLatencyPercentiles` must build a *complete* `Record<UsageOp, …>` itself; it cannot rely on the query returning one row per op.
5. **`jobs.fit` is `NOT NULL`** (`db/schema.ts:174`, `db/migrations/0000_legal_pandemic.sql`). The ticket's `fitToTailor` denominator, "distinct jobs with `fit` populated", is therefore **identical to "all jobs"** — see §2.3.4. This is not a discrepancy to paper over silently; it is FND-04/FND-05's deliberate Job-atomicity invariant.
6. **`jsonb_array_length(projects) > 0` works** and is the SQL equivalent of LIB-02's `hasLibrary()` (`lib/db/queries/library.ts:177-180`, which is `projects.length > 0` **and** `deletedAt IS NULL`). Probe-confirmed against a two-row table.
7. **Parenthesised route-group segments already work in this repo's import specifiers** for both `next build` and Vitest: `app/(app)/settings/page.tsx:1` imports `'@/app/(app)/settings/_components/delete-account-confirm'`, and `app/(app)/settings/page.test.tsx:5` imports `'@/app/(app)/settings/page'`. §2.1's helper location relies on this.
8. **`middleware.ts`'s matcher already covers `/admin`** (`middleware.ts:47`, `'/((?!api/|_next/static|_next/image|favicon.ico).*)'`) and `PUBLIC_PATHS` (lines 12–17) is an allowlist-by-omission, so `/admin` is *already* authentication-gated the moment the page exists. This ticket adds the **authorization** layer only.
9. **`next@15.5.20` is installed** (checked via `node_modules/next/package.json`), i.e. past the 15.2.3 fix for the `x-middleware-subrequest` middleware-bypass class (CVE-2025-29927). §2.4's page-level guard is defense in depth, not a patch for that.
10. **`db/index.ts`'s `db` export is neon-http, whose `.transaction()` throws unconditionally** (`node_modules/drizzle-orm/neon-http/session.js:151-159`, verified and recorded in `docs/plans/PLT-01.md` §2.1). Do **not** try to wrap the four aggregate queries in a transaction with `db` — it will throw at runtime and pass no test that mocks `dbTx`. See §4 "Snapshot consistency".
11. **`pgEnum(...).enumValues` exists** (`node_modules/drizzle-orm/pg-core/columns/enum.d.ts`), so `usageOpEnum.enumValues` is the source of truth for "all six ops" in §2.3.3. (`UsageOp.options` from `lib/schemas/persisted.ts:96` is the equivalent Zod-side list.)
12. **A PGlite boot + the real migration chain exceeds Vitest's 5000 ms default under full-suite load** (ISS-29). Every PGlite-backed `beforeAll`/`it` in this repo passes `30_000` as its **third argument** — `vi.setConfig` inside a hook is a silent no-op because a task's timeout is closed over at collection time. See `lib/db/queries/library.test.ts:30`, `app/api/account/delete/route.test.ts:234`.

---

## 1. Scope

**In scope** (ticket Deliverables 1–3):

1. `lib/db/queries/admin.ts` (+ `lib/db/queries/admin.test.ts`) — four aggregation functions over `usage_events` / `users` / `libraries` / `jobs` / `tailored_resumes` / `briefs`.
2. `app/(admin)/admin/page.tsx` — server component rendering the four aggregate views, plus `app/(admin)/admin/_components/**` for the presentational layer.
3. `app/(admin)/_lib/admin-emails.ts` — the single shared, dependency-free `ADMIN_EMAILS` allowlist parser/checker used by both the middleware gate and the page guard (§2.1).
4. `middleware.ts` — append-only: a 403 for any `/admin` request whose session email is not in the allowlist.
5. `.env.example` — append `ADMIN_EMAILS`.
6. Test appends: `middleware.test.ts` (the admin-gate acceptance item), plus new colocated tests for every new file.

**Explicitly out of scope:**

- Everything in the ticket's Non-goals: no APM/third-party dashboard, no real-time/live-updating page, **no per-user drill-down of any kind**, no role system beyond the env-var allowlist (no `isAdmin` column, no `db/schema.ts` change, no new migration).
- No new npm dependency and no `package.json` / `pnpm-lock.yaml` change — everything needed (`drizzle-orm`, `@electric-sql/pglite`, `@testing-library/react`, `vitest`) is already installed.
- No `vitest.config.ts` change — `test.include` already carries `app/**/*.test.{ts,tsx}`, `lib/**/*.test.ts` and `*.test.ts` (root), which reach every new test file (§3.6 still requires *verifying* this in the run output).
- No change to `lib/usage/record.ts` or the `usage_events` write path (ticket File-scope: read/import only).
- No change to `db/index.ts`, `db/schema.ts`, `auth.ts`, `auth.config.ts`, `app/layout.tsx`, or any `03`–`06` module file.
- No `(admin)` route group layout — the root `app/layout.tsx` already wraps it. Adding one is unnecessary surface.
- No admin **API** route. (And note §4: `middleware.ts`'s matcher excludes `/api/`, so a future admin API route would *not* inherit this gate.)
- No index/migration tuning for the aggregation queries (§4 "Query cost").

## 2. Change list

### 2.1 `app/(admin)/_lib/admin-emails.ts` — NEW — the one definition of "is an admin" (**ADR candidate**)

**ADR candidate (flagged, not buried).** "Admin authorization = an env-var email allowlist" is a genuinely new decision — PRD names no admin-auth mechanism at all. It is already recorded as a decision in `docs/prd/07-platform-launch/README.md`'s decision table *and* as open question #1 (owner: Horace) there, and the ticket's Feedback obligation #1 requires it be confirmed by Horace before or shortly after P5 launch. It is reversible in code (a `users.isAdmin` column or a hardcoded single-account check would replace this file and §2.2's branch, touching nothing else) but it is a security-boundary decision, so: **if Horace confirms the env-var allowlist as permanent, promote it to `docs/adr/0001-admin-authorization.md` at that point** — this repo has no ADR yet, and creating one for a decision still pending owner confirmation would misrepresent its status. Until then the sub-PRD's open-question row is the record. Do not silently treat this as settled.

**Why a separate module rather than inline code in `middleware.ts` and the page:** the check runs in two places (Edge middleware and the Node RSC). Duplicating a security predicate invites drift; a shared module gives one definition and one test. It must be **dependency-free** (no `@/db/*`, no `@/auth`, no `drizzle-orm`) because `middleware.ts` bundles for the Edge runtime.

**Why this path:** `docs/prd/breakdown-plan.md` §3 assigns `app/(admin)/**` wholesale to `07-platform-launch`, so this file is inside the module's ownership even though the ticket's File-scope enumerates only `app/(admin)/admin/page.tsx` and `app/(admin)/admin/_components/**`. A `_`-prefixed folder is excluded from Next.js routing. Record it as a documented File-scope widening (same class as PLT-02's `.github/scripts/backup.mjs`), and flag it for the Reviewer. Fact 7 confirms the parenthesised import specifier resolves in both toolchains. *Fallback if the Edge bundle ever rejects the specifier:* move to `lib/admin/emails.ts` and record the new path as a deviation — do not solve it by duplicating the predicate.

**Shape** (illustrative — the Builder implements; the behaviour, not the formatting, is load-bearing):

```ts
/** Parses ADMIN_EMAILS ("a@x.com, B@Y.com") into a normalized lookup set. */
export function parseAdminEmails(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0), // load-bearing: ''.split(',') === [''] would otherwise
                                    // put an empty string in the set and match an empty email.
  );
}

export function isAdminEmail(email: string | null | undefined): boolean {
  // Read process.env INSIDE the function, never at module scope: tests set/unset
  // ADMIN_EMAILS per test with no vi.resetModules(), and a Node-runtime change
  // takes effect without a rebuild. Use the LITERAL `process.env.ADMIN_EMAILS`
  // access — a computed `process.env[key]` is not statically analysable and is not
  // inlined into an Edge bundle (see §4 "Edge env inlining").
  const allowlist = parseAdminEmails(process.env.ADMIN_EMAILS);
  if (allowlist.size === 0) return false;           // fail closed: unset/empty ⇒ nobody is admin
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return false;                    // fail closed: null/undefined/'' is never admin
  return allowlist.has(normalized);
}
```

Three behaviours are non-negotiable and each gets its own test (§3.2): **unset/empty `ADMIN_EMAILS` ⇒ deny everyone**; **nullish/empty email ⇒ deny**; **case- and whitespace-insensitive match** (`" Horace@Example.COM "` in the env matches `horace@example.com` from the session). The `allowlist.size === 0` early return is intentionally redundant with `.has()` on an empty set — it exists so the fail-closed intent is unmissable to a reader; keep it and keep the comment.

### 2.2 `middleware.ts` — append-only

`middleware.ts` is 01-foundation-owned; `breakdown-plan.md` §3 permits append-only edits by a non-owning module after the owner is merged, and this ticket's File-scope authorises exactly this append. **Do not restructure** `PUBLIC_PATHS`, the handler's existing flow, or the `config.matcher` (no matcher change is needed — fact 8).

Append, in this order, *after* the existing `if (!req.auth) { … redirect('/signin') }` guard and before the final `return NextResponse.next()`:

```ts
// PLT-03 — /admin authorization (authentication is already handled above).
// Segment-scoped, NOT a bare prefix test: `pathname.startsWith('/admin')` would
// also gate a future /administrators page. Same class of bug as FND-08 Reviewer
// finding #3 (`api` vs `api/`) — see this file's own config comment.
function isAdminPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/');
}
…
if (isAdminPath(pathname) && !isAdminEmail(req.auth.user?.email)) {
  return new NextResponse('Forbidden', { status: 403 });
}
```

Decisions inside this small block, each deliberate:

- **403, not a redirect.** The ticket allows "redirect or 403". A 403 cannot loop, is directly assertable in `middleware.test.ts`, and non-disclosure is not a goal here (the admin page's existence is in the public PRD). An authenticated non-admin sees a plain 403; an *unauthenticated* visitor still gets the pre-existing `/signin` redirect, because this branch sits after the `!req.auth` guard.
- **Ordering matters**: authentication first (existing behaviour, unchanged), authorization second. Never gate `/admin` before the auth check — the 403 would then leak "this path exists and you are not signed in" instead of the normal sign-in flow.
- `req.auth.user?.email` — the optional chain on `user` is required for type-safety and is itself fail-closed (undefined ⇒ `isAdminEmail(undefined)` ⇒ `false`).
- Import: `import { isAdminEmail } from '@/app/(admin)/_lib/admin-emails';` (§2.1).

**Trust note for the Reviewer:** under `session: { strategy: 'database' }` (`auth.config.ts:37`), `req.auth` is produced by `auth.config.ts`'s `session()` callback from the **AdapterUser row** (`auth.config.ts:52-62`), i.e. `session.user.email` is read out of the `users` table, not out of a client-supplied JWT. It is not forgeable by the browser.

### 2.3 `lib/db/queries/admin.ts` — NEW — the four aggregations

**File header must state, prominently:** this is the **only** module in the codebase that intentionally queries across all users, i.e. the one deliberate exception to PRD §8.3's "全部查询以 session userId 约束" (the rule `lib/db/queries/library.ts`'s header restates and every route enforces via `requireUserId()`). Therefore:

- **No function here takes a `userId` parameter**, ever. That is the structural guarantee that this module cannot become the per-user drill-down the ticket's Non-goals forbid.
- **Every function returns scalars/aggregates only** — never a row, never an id, never an email. A future "just add the user id for debugging" edit is a privacy regression, not a convenience.
- **The only permitted importer is `app/(admin)/admin/page.tsx`.** §3.5 adds a guard test for this.

**2.3.1 Module preamble — build-time safety and the memoised lazy `db` (copy LIB-02's pattern; this is not optional).**

`db/index.ts` throws at import time when `DATABASE_URL` is unset (FND-05's tested fail-fast), and `next build`'s "Collecting page data" phase statically imports every page module. `app/(admin)/admin/page.tsx` imports this module directly, so a top-level `import { db } from '@/db/index'` here **breaks `pnpm build` on any checkout with no env vars, including CI** — the exact failure FND-08 shipped and had to bounce-fix. Reproduce `lib/db/queries/library.ts:119-132` verbatim in spirit:

```ts
let dbIndexPromise: Promise<typeof import('@/db/index')> | null = null;
function dbIndex() { dbIndexPromise ??= import('@/db/index').catch((e) => { dbIndexPromise = null; throw e; }); return dbIndexPromise; }
async function defaultDb(): Promise<Executor> { const { db } = await dbIndex(); return db; }
```

The **memoisation is load-bearing, not a micro-optimisation** — `lib/db/queries/library.ts:96-118` documents why: Vitest's mocker re-resolves a `vi.doMock`-ed specifier on *every* `import()` call, and two `import()`s issued in the same tick race (one gets the mock, one loads the real module and dies on the `DATABASE_URL` fail-fast). §2.4's page calls all four functions inside one `Promise.all` — precisely that same-tick concurrency. Copy the pattern, keep the explanatory comment, do not "simplify" it.

`@/db/schema` and `drizzle-orm` are connection-free and are imported statically (same as `library.ts`).

**2.3.2 Shared types, options, and the window.**

```ts
export type Executor = PgDatabase<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;
export type AdminQueryOptions = { executor?: Executor };
export type WindowedQueryOptions = AdminQueryOptions & { now?: number };
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
```

- `Executor` is defined **locally**, mirroring `lib/db/queries/library.ts:85-89`, rather than imported from that 03-library-owned file — a 4-line type alias is cheaper than a cross-module coupling. Note the duplication in a comment.
- The optional `executor` / `now` parameters are **additive**; the ticket's stated signatures (`getWeeklyCost(): Promise<number>` etc.) still hold when called with no arguments. This is exactly the precedent LIB-02 set with `upsertLibrary(..., executor?)`. `now` exists so window-boundary tests are deterministic without fake timers; `executor` exists so tests can hand in a PGlite client directly.
- Window: `const windowStart = (opts?.now ?? Date.now()) - WEEK_MS;` filtered with `gte(usageEvents.createdAt, windowStart)` — **inclusive** at exactly 7 days ago, matching the ticket's `createdAt >= <7 days ago>`. `usage_events.created_at` is `bigint` epoch-ms (`db/schema.ts:258`, mode `'number'`), so this is plain number arithmetic — no `Date` objects, no timezone.
- Rolling 7 days, **not** a calendar week (the ticket's literal definition). Say so in a comment so nobody "fixes" it into `date_trunc('week', …)`.
- **Coercion rule, stated once and applied everywhere:** every numeric value read out of a query result passes through `Number(x ?? 0)` before it leaves this module. Facts 1 and 3 make this mandatory for `sum()` and prudent for everything else; the module's own tests run on PGlite while production runs on neon-http, and this rule is what makes that substitution safe.

**2.3.3 `getWeeklyCost` / `getLatencyPercentiles` / `getDroppedRate`.**

```ts
export async function getWeeklyCost(opts?: WindowedQueryOptions): Promise<number> {
  const db = opts?.executor ?? (await defaultDb());
  const [row] = await db.select({ total: sum(usageEvents.costUsd) })   // SQL<string | null> — fact 1
    .from(usageEvents).where(gte(usageEvents.createdAt, windowStart));
  return Number(row?.total ?? 0);                                       // NULL on an empty window — fact 4
}
```

```ts
export async function getLatencyPercentiles(opts?: WindowedQueryOptions)
  : Promise<Record<UsageOp, { p50: number; p95: number }>> {
  const rows = await db.select({
      op: usageEvents.op,
      p50: sql<number>`percentile_cont(0.5) within group (order by ${usageEvents.durationMs})`,
      p95: sql<number>`percentile_cont(0.95) within group (order by ${usageEvents.durationMs})`,
    }).from(usageEvents).where(gte(usageEvents.createdAt, windowStart)).groupBy(usageEvents.op);
  // Record<UsageOp, …> is TOTAL; a GROUP BY returns NO row for an op with no events
  // in the window (fact 4), so seed all six ops first and overlay what came back.
  const out = Object.fromEntries(usageOpEnum.enumValues.map((op) => [op, { p50: 0, p95: 0 }]))
    as Record<UsageOp, { p50: number; p95: number }>;
  for (const r of rows) out[r.op] = { p50: Number(r.p50 ?? 0), p95: Number(r.p95 ?? 0) };
  return out;
}
```

- **`percentile_cont`, not `percentile_disc`** — the linear-interpolation definition, which is the standard reading of a latency p50/p95 and the one PRD §7's "p50 延迟 Fit ≤ 30s / Tailor ≤ 45s / Prep ≤ 90s" targets imply. Postgres's formula, for N sorted values `x[0..N-1]`: `pos = p * (N - 1)`, result `= x[⌊pos⌋] + (pos - ⌊pos⌋) * (x[⌈pos⌉] - x[⌊pos⌋])`. Worked, probe-verified (fact 2): `[10,20,30,40]` ⇒ p50 `25`, p95 `38.5`. **Write this formula in a comment** — the acceptance test's hand-computed expectations are only checkable against it.
- Six ops, never five or seven: `usageOpEnum.enumValues` (`db/schema.ts:74-81`) deliberately excludes `'score'` (pure code, folded into `'cross'`).
- **`{ p50: 0, p95: 0 }` means "no events for this op in the window"**, and the page renders `—` for that case (§2.5). Document the convention in the function's doc comment. Widening the return type to carry a count would break the ticket's stated signature; if the Builder judges the ambiguity unacceptable, that is a ticket-text change to raise, not to make silently.

```ts
export async function getDroppedRate(opts?: WindowedQueryOptions): Promise<number> {
  const [row] = await db.select({ dropped: sum(usageEvents.droppedCount), events: count() })
    .from(usageEvents).where(gte(usageEvents.createdAt, windowStart));
  const events = Number(row?.events ?? 0);
  return events === 0 ? 0 : Number(row?.dropped ?? 0) / events;   // 0/0 ⇒ 0, never NaN
}
```

**Metric-semantics warning that must reach the rendered page, not just the code:** this is the ticket's literal formula, `SUM(droppedCount) / COUNT(*)` — **average dropped items per operation**, not a percentage. PRD §6/§7's Q1 gate ("dropped < 15%") means a genuine *rate*, `dropped / total candidate items`, which is exactly how `eval/assertions/q1.ts:99-102` computes it (`assertQ1DroppedRate(droppedCount, totalCount)`) — and `usage_events` has no total-candidate-items column, so that rate is **not computable here** with the current schema. Label the page value precisely (§2.5) as "dropped items per operation (7d avg)", never as "dropped rate %", so nobody reads it against the 15 % gate. If a true rate is wanted, the fix is a new `usage_events` column (per FND-10 Feedback obligation #2 and this ticket's Feedback obligation #3 — extend the table, never build a parallel one), which is a follow-up ticket, not this one. Carried into §5 Q3.

**2.3.4 `getFunnelConversion`** — six counts + three ratios, all-time.

```ts
const ratio = (n: number, d: number) => (d === 0 ? 0 : n / d);  // same 0-denominator
                                                                // convention as eval/assertions/q1.ts:102
```

| Figure | Query | Notes |
|---|---|---|
| `totalUsers` | `count()` on `users` | `users.id` is the PK ⇒ `COUNT(*)` is already distinct. Shrinks when PLT-01's hard-delete removes a user — see §4. |
| `usersWithLibrary` | `countDistinct(libraries.userId)` where `isNull(libraries.deletedAt)` **and** `` sql`jsonb_typeof(${libraries.projects}) = 'array' and jsonb_array_length(${libraries.projects}) > 0` `` | Mirrors LIB-02's `hasLibrary()` (`library.ts:177-180`) exactly — soft-deleted rows do **not** count, empty `projects` do **not** count. The ticket text omits `deletedAt`; matching the repo's one existing definition of "has a library" is the right call, and must be stated in a comment. The `jsonb_typeof` guard keeps a drifted non-array row from turning the whole page into a 500. |
| `totalJobs` | `count()` on `jobs` | **This is the ticket's "jobs with `fit` populated"** — `jobs.fit` is `NOT NULL` (fact 5), the DB-level mirror of FND-04's Job-atomicity invariant (a Job only exists once READ+CROSS+SCORE produced jd+ledger+fit). Use `count()` with a comment citing the constraint; do **not** write an `isNotNull(jobs.fit)` filter that reads like a real filter but is a tautology and invites a future reader to believe fit-less jobs exist. |
| `tailoredJobs` | `countDistinct(tailoredResumes.jobId)` | `tailored_resumes.job_id` has an FK to `jobs.id` with `ON DELETE cascade`, so no orphan rows can inflate this. |
| `interviewingJobs` | `count()` on `jobs` where `eq(jobs.status, 'interviewing')` | |
| `interviewingWithBrief` | `countDistinct(jobs.id)` from `jobs` `innerJoin(briefs, eq(briefs.jobId, jobs.id))` where `eq(jobs.status, 'interviewing')` | Join, not a subquery — one statement, index-friendly on `briefs_job_id_idx`. |

Returns `{ signupToLibrary: ratio(usersWithLibrary, totalUsers), fitToTailor: ratio(tailoredJobs, totalJobs), interviewingToBrief: ratio(interviewingWithBrief, interviewingJobs) }`.

- **All-time, not windowed** — deliberate, and asymmetric with the three 7-day metrics above. The ticket's definitions contain no window, and PRD §8.4 says "周成本" (weekly *cost*) only. State the asymmetry in a comment and on the page (§2.5) so a reader is never confused about which number covers which period. Raised as §5 Q2 for Horace.
- Resolve `const db = opts?.executor ?? (await defaultDb())` **once**, then issue the six counts under one `Promise.all` (a single `dbIndex()` resolution — §2.3.1).
- Returns ratios in `[0, 1]` (not percentages); the page multiplies by 100 for display.

### 2.4 `app/(admin)/admin/page.tsx` — NEW

```tsx
export const dynamic = 'force-dynamic';                  // see below — required, not decorative
export const metadata = { title: 'Admin — observability' };

export default async function AdminPage() {
  const session = await auth();
  if (!isAdminEmail(session?.user?.email)) notFound();   // defense in depth (§2.1 helper)
  const [weeklyCostUsd, latency, droppedPerOp, funnel] = await Promise.all([
    getWeeklyCost(), getLatencyPercentiles(), getDroppedRate(), getFunnelConversion(),
  ]);
  return <ObservabilityDashboard … />;
}
```

- **`export const dynamic = 'force-dynamic'` is required.** Without it Next may attempt to prerender this page at build time, which would execute the DB queries during `next build` — on a checkout with no `DATABASE_URL` that is a build failure, and on a real deployment it would bake stale numbers into a static page. `app/layout.tsx:11` already declares it, but declaring it here removes any reliance on segment-config cascade semantics — the same belt-and-suspenders reasoning `app/layout.tsx:7-10` records for itself.
- **The page-level guard is mandatory even though §2.2 gates the route.** Middleware is a single point of failure (a matcher edit, a future `/api/admin/**` route which the matcher excludes, or a framework-level bypass of the historic CVE-2025-29927 class); the guard costs one line. `notFound()` (from `next/navigation`) is the idiomatic RSC refusal and renders a 404. The status asymmetry with middleware's 403 is acceptable and intentional: in normal operation this branch is unreachable, and a 404 from an unreachable guard leaks less than a 403.
- **Guard before data.** `notFound()` must run before any query so a non-admin never causes an aggregate read.
- Two `auth()` calls per admin render (root layout + this page) means two session lookups. Accepted at this scale; noted so it is not mistaken for a bug.
- All four queries in one `Promise.all` — this is the concurrency the memoised `dbIndex()` (§2.3.1) exists for.
- Import the four functions from `@/lib/db/queries/admin`; import `isAdminEmail` from `@/app/(admin)/_lib/admin-emails`.

### 2.5 `app/(admin)/admin/_components/observability-dashboard.tsx` — NEW

A **synchronous, props-only** server component: `{ weeklyCostUsd: number; latency: Record<UsageOp, {p50:number;p95:number}>; droppedPerOp: number; funnel: {signupToLibrary:number;fitToTailor:number;interviewingToBrief:number}; generatedAt: number }`. No `'use client'`, no data fetching, no `auth()`.

Splitting presentation from fetching is not decoration: it makes the whole rendering surface testable with the repo's existing sync-component pattern (`app/(app)/settings/page.test.tsx`, `app/(legal)/privacy/page.test.tsx`) instead of depending on `render(await Page())` for an async RSC, which `@testing-library/react` supports only incidentally. It also matches the ticket's `_components/**` File-scope.

Content requirements (PRD names no visual design for this internal tool — plain semantic HTML with inline styles, matching `app/(app)/settings/page.tsx`'s existing style):

- An `<h1>` naming the page, and an explicit statement of **which window each block covers**: "Cost / latency / dropped — rolling 7 days ending <generatedAt>"; "Funnel conversion — all time".
- Weekly cost: `$` + 2 decimals.
- Latency table: one row per `UsageOp` (all six, in `usageOpEnum` order), columns p50 / p95 in ms; render `—` when `p50 === 0 && p95 === 0` (§2.3.3's convention).
- Dropped: labelled **"dropped items per operation (7d avg)"** — never "dropped rate %" (§2.3.3).
- Funnel: the three ratios as percentages with 1 decimal, each shown **next to its PRD §7 target** (`≥ 50 %`, `≥ 25 %`, `≥ 60 %` — `docs/PRD.md:211-213`), and each labelled with its exact definition (e.g. "users with a non-empty library ÷ registered users"). A ratio without its definition is unreadable six months later; the labels are what make the page a measurement, not a vibe.
- **No user-identifying content of any kind** — no email, no user id, no company/role name. This is a ticket Non-goal *and* a privacy boundary: PLT-01's published privacy page promises account-scoped data handling. §3.4 tests it.

### 2.6 `.env.example` — append

`.env.example` is 01-foundation-owned; this ticket's File-scope authorises the append (PLT-02 precedent). Add after `GLOBAL_DAILY_SPEND_LIMIT_USD=` and **before** the PLT-02 `R2_*` comment block (that block is explicitly about CI-only GitHub Actions secrets; `ADMIN_EMAILS` is a real app runtime var and belongs with the bare `KEY=` lines):

```
# Comma-separated email allowlist for /admin (PLT-03). Matched case-insensitively
# against the signed-in session's email. EMPTY OR UNSET ⇒ NOBODY can reach /admin.
# On Vercel, redeploy after changing this — Edge middleware may inline it at build time.
ADMIN_EMAILS=
```

### 2.7 Files explicitly NOT changed

`package.json`, `pnpm-lock.yaml`, `vitest.config.ts`, `db/schema.ts`, `db/migrations/**`, `db/index.ts`, `auth.ts`, `auth.config.ts`, `app/layout.tsx`, `lib/usage/record.ts`, `lib/db/queries/library.ts`, anything under `03`–`06`. If the Builder finds any of these unavoidable, that is a deviation to record in the ticket and flag to the Reviewer, not to absorb.

### 2.8 Writeback (Builder, after the suite is green)

Per this repo's established convention (see `docs/prd/07-platform-launch/README.md` v0.2–v0.4): add a Changelog entry to `docs/prd/07-platform-launch/tickets/PLT-03-admin-observability.md` (version +0.1) and a matching line to the sub-PRD README, recording at minimum — (a) the File-scope widenings (`app/(admin)/_lib/admin-emails.ts`, `middleware.test.ts` append, colocated `*.test.tsx` files); (b) the `fitToTailor` denominator reconciliation (§2.3.4 / fact 5); (c) the dropped-metric semantics divergence from PRD's Q1 rate (§2.3.3); (d) that open question #1 (admin-auth mechanism) remains **open pending Horace**, per the ticket's Feedback obligation #1 — this ticket shipping does not close it.

## 3. Test plan

Every acceptance item, and what proves it:

| Acceptance item (ticket) | Where | How |
|---|---|---|
| `getWeeklyCost` sums only rows in the last 7 days | `lib/db/queries/admin.test.ts` | §3.1 |
| `getLatencyPercentiles` p50/p95 per op, deterministic | `lib/db/queries/admin.test.ts` | §3.1 |
| `getFunnelConversion`'s three ratios vs hand-computed values | `lib/db/queries/admin.test.ts` | §3.1 |
| `/admin` rejected for a non-allowlisted email, allowed for an allowlisted one (two integration tests) | `middleware.test.ts` (append) + `app/(admin)/admin/page.test.tsx` | §3.3 |
| `pnpm test` green | full suite | §3.6 |

### 3.1 `lib/db/queries/admin.test.ts` (PGlite, the repo's standard substrate)

Setup copies `lib/db/queries/library.test.ts:36-63`: one `new PGlite()` + `drizzle(client, { schema })` + `migrate(db, { migrationsFolder: './db/migrations' })` in `beforeAll`, **with `30_000` passed as the third argument** to `beforeAll` and to every `it` (fact 12 — omitting it produces flaky 5 s timeouts only under full-suite load). Inject the client via the `executor` option (§2.3.2) — simpler and race-free compared with `vi.resetModules()` + `vi.doMock('@/db/index')`; keep **one** test that goes through the `vi.doMock` path as well, so the production lazy-import path is exercised at least once (§3.5).

**Isolation is the one real trap here.** Unlike `library.test.ts`, whose queries are all `userId`-scoped so a fresh `crypto.randomUUID()` user gives free isolation, these aggregates are **global**: every row any test seeds is visible to every other test's counts. Choose one and state it in a file comment:
- (recommended) **a fresh PGlite per `describe` block** (`beforeEach`/`beforeAll` inside the block), paying the boot cost a handful of times; or
- one PGlite plus an explicit `TRUNCATE … CASCADE` of the six tables in `beforeEach`.
Do **not** rely on distinct user ids for isolation — that is exactly the assumption this module breaks.

- **Weekly-cost window.** With `now = T` fixed, seed `usage_events` at `T - 1h`, `T - WEEK_MS` (boundary, **in**, since the filter is `>=`), `T - WEEK_MS - 1` (**out**), `T - 30d` (out). Assert the returned sum equals only the in-window rows' `costUsd` (use values that sum exactly in binary, e.g. `0.25 + 0.5`, or compare with `toBeCloseTo`). Add one test asserting an **empty** table returns `0`, not `NaN`/`null` (fact 4). Add one asserting the result is a `number`, not a string — that is the fact-1 regression guard.
- **Percentiles.** Seed op `'read'` with `durationMs` `[10, 20, 30, 40]` and op `'cross'` with `[100]`, all in-window; assert `read` ⇒ `{ p50: 25, p95: 38.5 }` and `cross` ⇒ `{ p50: 100, p95: 100 }` (probe-verified, fact 2). Assert the returned record has **all six** `usageOpEnum` keys and that the four ops with no rows are `{ p50: 0, p95: 0 }`. Add a row **outside** the window with an extreme duration and assert it does not move the percentiles.
- **Dropped.** Seed 4 in-window events with `droppedCount` `[0, 1, 2, 0]` ⇒ `3/4 = 0.75`. Assert an empty window ⇒ `0` (not `NaN`). Assert an out-of-window event with a large `droppedCount` is excluded.
- **Funnel.** Reuse the Zod-valid jsonb fixtures at `app/api/account/delete/route.test.ts:48-90` (`jd`, `ledger`, `fit`, `alignment`, `edit`, `rehearse`, `profile`, `project`) — `jobs.jd/ledger/fit`, `libraries.profile`, `briefs.rehearse` and `tailored_resumes.alignment/edits/fullDraftMd` are all `NOT NULL`, so seeding needs real shapes. The ticket's own worked example: **4 users, 1 with a non-empty library ⇒ `signupToLibrary === 0.25`**. Extend with the cases that catch the definitional bugs:
  - a user whose `libraries` row has `projects: []` ⇒ **not** counted;
  - a user whose `libraries` row is soft-deleted (`deletedAt` set) but has projects ⇒ **not** counted (mirrors `hasLibrary`);
  - 4 jobs, 1 with a `tailored_resumes` row ⇒ `fitToTailor === 0.25`; a second `tailored_resumes` row for the *same* job must not double-count (that is what `countDistinct` buys);
  - 5 jobs of which 2 are `interviewing`, 1 of those with a `briefs` row ⇒ `interviewingToBrief === 0.5`; a `briefs` row on a **non**-interviewing job must not count in either numerator or denominator;
  - **all tables empty ⇒ `{ 0, 0, 0 }`**, no `NaN` (this is the single most likely production state on day one).

### 3.2 `app/(admin)/_lib/admin-emails.test.ts` (plain node env)

Save/restore `process.env.ADMIN_EMAILS` in `beforeEach`/`afterEach`. Cases, each a named test:
`ADMIN_EMAILS` unset ⇒ any email denied · set to `''` ⇒ denied · set to `','` or `' , '` ⇒ denied (the `.filter(Boolean)` guard) · `email` `undefined` / `null` / `''` / `'   '` ⇒ denied even when the allowlist is non-empty · exact match ⇒ allowed · differing case on either side ⇒ allowed · surrounding whitespace on either side ⇒ allowed · a non-listed address ⇒ denied · a *substring* of a listed address (`'a@x.com'` vs listed `'aa@x.com'`) ⇒ denied (set membership, never `includes`).

### 3.3 The admin gate — the two acceptance integration tests, at both layers

**`middleware.test.ts` (append; do not restructure the file).** The existing harness already gives everything needed: `vi.mock('@/auth', …)` pass-through at lines 7–9, `fakeReq(pathname, auth)` at 21–23, `isRedirect` at 25–27. Set `process.env.ADMIN_EMAILS = 'admin@example.com'` in `beforeEach` and restore in `afterEach` (§2.1 reads env at call time, so no `vi.resetModules()` is needed — if a Builder finds themselves reaching for `resetModules` here, the helper is reading env at module scope and must be fixed).

- `/admin` + `{ user: { email: 'nobody@example.com' } }` ⇒ `res.status === 403`. *(acceptance item 4a)*
- `/admin` + `{ user: { email: 'admin@example.com' } }` ⇒ no redirect, `x-middleware-next === '1'`. *(acceptance item 4b)*
- `/admin` + `{ user: { email: 'ADMIN@Example.com ' } }` ⇒ allowed (normalisation).
- `/admin` + `{ user: {} }` (no email) ⇒ 403.
- `/admin` with `ADMIN_EMAILS` **unset** + an otherwise-plausible email ⇒ 403 (fail-closed).
- `/admin` + `auth: null` ⇒ still the pre-existing `/signin` redirect, **not** a 403 (ordering guard).
- `/admin/anything` ⇒ gated; `/administrators` ⇒ **not** admin-gated (reaches the normal authenticated pass-through). This is the FND-08-finding-#3-class regression guard; without it, a `startsWith('/admin')` implementation passes every other test.
- The existing `/jobs`, `/`, `/signin`, `/privacy`, `/tos` assertions must keep passing **unmodified**.

**`app/(admin)/admin/page.test.tsx`** — the page-level guard, with no DB in the loop. `vi.hoisted` + `vi.mock('@/auth', () => ({ auth: mockAuth }))` (the stable-reference pattern at `app/api/account/delete/route.test.ts:20-25`), `vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }))` — mock it as *throwing*, because the real `notFound()` throws and a non-throwing stub would let execution fall through and silently prove nothing. `vi.doMock('@/lib/db/queries/admin', …)` with four spies, then `vi.resetModules()` + `await import('@/app/(admin)/admin/page')`.
- non-allowlisted session ⇒ `await expect(AdminPage()).rejects.toThrow(/NEXT_NOT_FOUND/)` **and** all four query spies `not.toHaveBeenCalled()` (guard-before-data);
- `auth()` returning `null` ⇒ same;
- allowlisted session ⇒ resolves, and all four spies were called.

### 3.4 `app/(admin)/admin/_components/observability-dashboard.test.tsx` (jsdom)

`// @vitest-environment jsdom`, `afterEach(cleanup)` explicitly (this repo does not enable Vitest globals — see `app/(legal)/privacy/page.test.tsx:7-10`). Render with hand-built props and assert: the `<h1>`; the formatted cost; all six op rows present; an op with `{0,0}` renders `—`; the three funnel percentages and their PRD targets; the dropped figure is labelled "per operation", not "%"; the "rolling 7 days" vs "all time" window labels both appear. Plus the privacy guard, mirroring `app/(legal)/privacy/page.test.tsx:33-39`: `container.textContent` matches **no** email-shaped string (`/[\w.+-]+@[\w-]+\.\w+/`) and no UUID-shaped string.

### 3.5 Structural / regression guards (not in the literal checklist, cheap, and exactly what the Reviewer will look for)

- **Build-time safety:** `pnpm build` with **zero** env vars set must exit 0. This is the repo's recurring failure mode (FND-08 v0.1 shipped it; PLT-01's plan §2.2 re-flagged it). Run it; do not assume.
- **No static `@/db/index` import** in `lib/db/queries/admin.ts`: one test asserting `await import('@/lib/db/queries/admin')` succeeds with `DATABASE_URL` unset (`delete process.env.DATABASE_URL` + `vi.resetModules()`), mirroring the intent of `db/index.test.ts`'s fail-fast tests.
- **Concurrent-import guard:** one test that `vi.doMock`s `@/db/index` with a PGlite client and calls all four functions in a single `Promise.all` — the exact same-tick race `lib/db/queries/library.test.ts:96-118` documents. If the memo in §2.3.1 is dropped, this test fails and the page's real code path is the thing that would have broken.
- **Importer guard:** a test asserting that the only file importing `@/lib/db/queries/admin` is the admin page (read the repo's `app/**`/`lib/**` sources and match `from '@/lib/db/queries/admin'`) — the mechanical expression of §2.3's "no cross-user query path leaks out of this module". Keep it simple and skip `node_modules`/`.next`.
- `pnpm lint` clean.

### 3.6 Discovery

`vitest.config.ts`'s `include` already covers `lib/**/*.test.ts`, `app/**/*.test.{ts,tsx}` and root `*.test.ts`, so no config change is needed — but this repo has a documented history of new test files silently not running (FND-02/05/06/08/09/EVL-01/EVL-02 each fixed it for their own location). **Verify the new files appear by name in `pnpm test`'s output**; do not infer it from a green run.

## 4. Risks & edge cases

**Security — this is the ticket's centre of gravity; the Reviewer should start here.**

- **Fail-closed in every direction.** Unset/empty `ADMIN_EMAILS`, an all-whitespace value, a session with a null/empty email, `req.auth` present but `user` undefined — every one of these must **deny**. The single highest-risk line in the whole ticket is `''.split(',') === ['']`: without the `.filter(e => e.length > 0)` in §2.1, an unset env var produces an allowlist containing the empty string, and any session whose email normalises to `''` becomes an admin. §3.2 tests it directly.
- **Segment-scoped path matching.** `pathname.startsWith('/admin')` would gate `/administrators` too. It fails *closed*, so it is not an exploit — but it is the same bug class as FND-08 Reviewer finding #3 (`api` vs `api/`), which this repo already paid for once. §3.3's `/administrators` test is the guard.
- **Middleware is not the only gate.** `middleware.ts`'s matcher excludes `/api/`, so **a future admin API route would not inherit this gate** and must call `isAdminEmail()` itself. Say so in a comment at the middleware branch. The page-level `notFound()` (§2.4) covers the page for the same reason.
- **This module is the one intentional violation of PRD §8.3's user-scoping rule.** Mitigations, all structural rather than aspirational: no `userId` parameter on any exported function; aggregates only in every return type; one permitted importer (§3.5's importer guard); no PII in the rendered output (§3.4). A future "add a user column so I can see who's spending" edit is a privacy regression and needs a product decision, not a patch.
- **Trust of `session.user.email`.** Under the database session strategy it comes from the `users` row via `auth.config.ts:52-62`, not from a client-controlled token — not forgeable. Two residual, low-probability caveats worth Horace knowing: (i) Auth.js does not check Google's `email_verified` claim by default, so an allowlist entry should be an address on a domain the owner actually controls; (ii) `users.email` is `UNIQUE` (`db/schema.ts:102`), so one email is one account — sign-in via the Resend magic-link provider proves control of the mailbox.
- **Edge env inlining.** Next.js can inline statically-analysable `process.env.X` reads into the Edge middleware bundle at build time. Consequence: after changing `ADMIN_EMAILS` in Vercel, **redeploy** rather than assuming a restart suffices; and never use a computed `process.env[key]` in §2.1 (it is not statically analysable and could read `undefined` at the Edge — which fails closed, i.e. locks *everyone* out, but is still a confusing outage). Documented in `.env.example` (§2.6). Genuinely unverified until Horace has a live deployment — same standing infra gap as FND-05/FND-08/PLT-02.
- **Pre-existing, not worsened:** `middleware.ts:48-51` already records the open question of whether `auth()`'s database-strategy adapter call works under the Edge runtime (with a commented-out `runtime: 'nodejs'` escape hatch). This ticket makes middleware depend on one more field of the same session object. If session resolution fails at the Edge, `req.auth` is null and the **pre-existing** `/signin` redirect fires — fail-closed, no admin exposure. This ticket neither fixes nor worsens that question.

**Concurrency.**

- Every function here is **read-only**; there is no write path, no lock, and no transaction. Concurrent page loads cannot corrupt anything, and `recordUsage()` (`lib/usage/record.ts`) writing while the page reads is ordinary Postgres READ COMMITTED behaviour.
- **Snapshot consistency is deliberately not guaranteed.** The four functions (ten statements total) run as separate queries, so a `usage_events` insert landing between them can make the displayed numbers mutually inconsistent by one event. Accepted for an internal summary page — PRD §8.4 calls for "一张表加一页汇总", not a consistent analytics snapshot. **Do not "fix" this by wrapping the reads in a transaction**: the production client is neon-http, whose `.transaction()` throws unconditionally (fact 10), so that change would pass PGlite-backed tests and fail in production. A consistent snapshot would require `dbTx`/neon-serverless and a `REPEATABLE READ` transaction — out of scope, and not worth it here.
- `getLatencyPercentiles`'s `percentile_cont` sorts in-window rows per op. At v1 volumes this is trivial; at 10⁶ rows it would be a sort, not an index scan (see below).

**Data / metric-semantics risks (product-signal findings, not bugs — ticket Feedback obligation #2).**

- **`interviewingToBrief` measures the *current* interviewing cohort.** `jobs.status` is current state, not history: a job that got a brief while `interviewing` and later moved to `closed` leaves **both** the numerator and the denominator. The ratio therefore drifts as jobs progress and is not a stable historical conversion rate. This is the only thing computable from the current schema (no status-transition log) and matches the ticket's literal definition — but it must be labelled on the page and surfaced to Horace, not silently presented as PRD §7's ≥ 60 % target.
- **`signupToLibrary`'s denominator shrinks after account deletion.** PLT-01's hard-delete removes the `users` row, so both sides of the ratio lose the user. Post-deletion the figure describes surviving accounts only. Unavoidable given PRD §5.6's "删号 = 硬删该用户全部数据" — worth one sentence in the page's label.
- **The dropped figure is not PRD's dropped rate** (§2.3.3). Mislabelling it as a percentage would put a number next to a 15 % gate that it does not measure.
- **Zero-denominator ⇒ 0** everywhere (`eval/assertions/q1.ts:102`'s convention). On an empty production database every ratio reads `0 %`, which looks like failure rather than "no data yet". Acceptable for v1; §5 Q4 raises the "show `—` when the denominator is 0" alternative.

**Driver-behaviour risk.** Tests run on PGlite, production on neon-http. `sum()` returns a string (fact 1); `bigint`/`count` parsing differs between the two drivers (fact 3). The `Number(x ?? 0)` rule (§2.3.2) is what makes the substitution safe — a Reviewer should check it is applied at **every** numeric read, since a miss produces a string-concatenation or `NaN` bug that PGlite-backed tests may not catch.

**Query cost.** `usage_events`'s only index is the composite `(user_id, op, created_at)` (`db/schema.ts:270-276`), whose leading column is `user_id` — these queries filter on `created_at` alone and will therefore sequential-scan. Correct and irrelevant at PRD's stated scale (a single-digit-user invite-gated v1), and adding an index means a migration in 01-foundation-owned `db/migrations/**`. **Deliberately not addressed**; recorded here so the Reviewer sees it was considered, not missed.

**Failure mode of the page.** `Promise.all` means one failing query fails the whole page (Next's error boundary). Acceptable for an internal tool; no partial-render/degrade logic — adding one would be unrequested surface.

**Build-time DB-free constraint.** The highest-probability implementation mistake in this ticket is a top-level `import { db } from '@/db/index'` in `lib/db/queries/admin.ts` (or a top-level import of some other helper that has one). It passes locally when a developer's shell has `DATABASE_URL` set and fails only in CI or on a clean checkout. §2.3.1 and §3.5 exist for this.

## 5. Open questions

| # | Question | Owner |
|---|---|---|
| 1 | **Is the env-var email allowlist the permanent admin-auth mechanism?** Already open question #1 in `docs/prd/07-platform-launch/README.md` and Feedback obligation #1 in the ticket. This plan implements it as specified; it does **not** close the question. If Horace prefers a `users.isAdmin` column or a hardcoded single-account check, §2.1 + §2.2 are the only code to change. If he confirms it, promote to `docs/adr/0001-admin-authorization.md` (§2.1). | Horace (product). Shipping this ticket does not resolve it. |
| 2 | **Should the funnel ratios be windowed?** This plan computes them all-time (the ticket's literal definitions carry no window) while cost/latency/dropped are rolling-7-day — an asymmetry the page states explicitly. A trailing-30-day funnel would be more actionable once real data exists. | Horace (product); a follow-up ticket, not a silent change here. |
| 3 | **A true dropped *rate* needs a schema change.** `SUM(droppedCount)/COUNT(*)` is dropped-per-operation; PRD §6/§7's "dropped < 15%" needs `dropped / total candidate items`, and `usage_events` has no total-items column. Per FND-10 Feedback obligation #2 and this ticket's #3, the fix is **extending `usage_events`**, never a parallel table. | Horace / a follow-up ticket in `01-foundation`'s file-scope. Out of scope here. |
| 4 | **Zero-denominator display:** ratios return `0` when the denominator is 0, so an empty database renders `0 %` rather than "no data". Changing this means either widening the return types (breaking the ticket's stated signatures) or having the page render `—` from a denominator it does not currently receive. | Builder's judgment for the page's *label* wording; any return-type change is a ticket-text change (Reviewer/Horace). |
| 5 | **File-scope widenings** — `app/(admin)/_lib/admin-emails.ts` (§2.1), the `middleware.test.ts` append (§3.3), and colocated `page.test.tsx` / `_components/*.test.tsx`. All are inside `breakdown-plan.md` §3's module-level globs or follow PLT-01/PLT-02's recorded precedent, but none is enumerated in the ticket's own File-scope. This plan recommends proceeding and recording them (§2.8). | Reviewer stage first; escalate to Horace only on disagreement. |
| 6 | **Edge-runtime verification of `ADMIN_EMAILS` and of `auth()`'s database-strategy session lookup in middleware** — both unverifiable offline (no live `DATABASE_URL`, no deployment). Carried forward from FND-05/FND-08's standing infra open questions, not introduced here. | Horace (infra), at P5 deployment. |
