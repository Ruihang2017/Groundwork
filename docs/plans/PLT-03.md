# PLT-03 — Implementation Plan

`/admin` observability page + `usage_events` aggregation queries + admin authorization gate.

| | |
|---|---|
| Ticket | `docs/prd/07-platform-launch/tickets/PLT-03-admin-observability.md` |
| Sub-PRD | `docs/prd/07-platform-launch/README.md` (decision table row 3; open question #1) |
| Master spec | `docs/PRD.md` §8.4 (observability policy), §7 (funnel metrics), §8.3 (isolation/privacy), §5.5 (dropped counting), §9 (cost figures) |
| Depends on (merged) | FND-10 (`lib/usage/record.ts`, `usage_events.droppedCount`/`status`), FND-08 (`auth.ts`, `auth.config.ts`, `middleware.ts`, `lib/auth/session.ts`), FND-05 (`db/schema.ts`, `db/index.ts`, `db/migrations/**`) |
| Branch from | `main` (`ticket/PLT-03`) |
| ADR candidate | Yes — §5 Q1. Flagged, not silently resolved. `docs/adr/` is currently empty; this plan does not write one (the decision owner is Horace, and `docs/adr/**` is outside this ticket's file-scope). |

This plan was produced by reading the ticket, `docs/prd/07-platform-launch/README.md`, `docs/prd/breakdown-plan.md` §3, `docs/PRD.md` §5.5–§5.7/§6/§7/§8.3/§8.4/§9, and the **current on-disk state** of `db/schema.ts`, `db/index.ts`, `middleware.ts`, `middleware.test.ts`, `auth.ts`, `auth.config.ts`, `lib/auth/session.ts`, `lib/config/quota.ts`, `lib/usage/record.ts`, `lib/db/queries/library.ts(+.test.ts)`, `app/layout.tsx`, `app/(app)/settings/page.tsx(+.test.tsx)`, `app/(legal)/privacy/page.test.tsx`, `app/api/account/delete/route.test.ts`, `vitest.config.ts`, `tsconfig.json`, `package.json`. Everything in §0 was **executed and observed**, not inferred.

---

## 0. Facts verified at planning time (do not re-derive; do not assume otherwise)

Each item below changes an implementation decision downstream. Evidence is the command that produced it.

**0.1 — PGlite supports `percentile_disc` / `percentile_cont` with `WITHIN GROUP` + `GROUP BY`.** Ran against the installed `@electric-sql/pglite@0.5.x` (PGlite is real Postgres compiled to WASM). For `durationMs` = 100,200,…,1000 grouped by op:

| expression | value returned |
|---|---|
| `percentile_disc(0.5) within group (order by d)` | `500` (JS `number`, exact) |
| `percentile_disc(0.95) within group (order by d)` | `1000` (JS `number`, exact) |
| `percentile_cont(0.5) within group (order by d)` | `550` |
| `percentile_cont(0.95) within group (order by d)` | **`954.9999999999999`** |

→ **Use `percentile_disc`.** `percentile_cont` interpolates in `double precision` and produces float noise, so a `toBe(955)` acceptance assertion would fail and the page would render `954.9999999999999 ms`. `percentile_disc` returns an *actually observed* latency (honest for a latency metric) and an exact integer (deterministic tests). §2.3 fixes the semantics.

**0.2 — Postgres integer division silently truncates the dropped rate to `0`.** Same session: with `sum(dropped)=6, count(*)=11`, `sum(dropped)/count(*)` returned **`0`** (both operands are `bigint`), while `sum(dropped)::double precision / count(*)` returned `0.5454545454545454`. The ticket's Deliverable 1 formula written literally as SQL is therefore a silent-wrong-answer bug. §2.3 divides in JS instead.

**0.3 — Division by zero raises in Postgres** (`select 0/0.0` → `division by zero`). Empty-window / empty-table denominators must never reach SQL division. §2.3 divides in JS with an explicit zero-denominator branch (same shape as `eval/assertions/q1.ts:102`, which already does `totalCount === 0 ? 0 : dropped/total`).

**0.4 — Drizzle's aggregate helpers carry runtime decoders; raw `sql<T>` does not.** From `node_modules/drizzle-orm/sql/functions/aggregate.js`: `count()` is `sql\`count(...)\`.mapWith(Number)`, `sum()` is `sql\`sum(...)\`.mapWith(String)`. A hand-written `` sql<number>`count(*)` `` has **no** decoder — `<number>` is a compile-time claim only. Postgres returns `int8`/`numeric` as **strings** through node-postgres-style drivers (which `@neondatabase/serverless` follows) but PGlite returns them as **numbers**, so an un-mapped raw aggregate passes every test and produces `"6" / 11` string math in production. → Every raw aggregate expression in this ticket **must** end with `.mapWith(Number)`; prefer drizzle's own `count()`/`countDistinct()`/`sum()` where they fit.

**0.5 — `next build` currently succeeds with zero env vars.** Ran `node node_modules/next/dist/bin/next build` with `DATABASE_URL`/`AUTH_SECRET` empty: exit 0, 11 routes, **every** route marked `ƒ (Dynamic)` (the root `app/layout.tsx` sets `export const dynamic = 'force-dynamic'`). This baseline must not regress — see §2.4 (`force-dynamic` + lazy DB import).

**0.6 — `pnpm lint` is already broken on this checkout, for a pre-existing reason.** `next build` printed `Failed to load plugin 'react-hooks' … Cannot find module 'eslint-plugin-react-hooks'` (and still exited 0); running eslint directly reproduces it. This is an install/hoisting gap in `node_modules`, **not** caused by this ticket. Try `pnpm install`; do **not** restructure `eslint.config.mjs` (01-foundation file-scope) to work around it.

**0.7 — `lib/db/queries/` does not exist on `main`.** `git ls-tree -r main` shows no `lib/db/**`. `lib/db/queries/library.ts` is LIB-02, currently unmerged on branch `ticket/LIB-02`. So: create the directory; and **whether or not LIB-02 has merged by the time you build, do not edit or import `library.ts`** (it is `03-library` file-scope). The one thing you need from it — the lazy memoized `@/db/index` import — is reproduced in full in §2.3 so this plan stands alone.

**0.8 — Zod v4 `z.enum(...).options` works** (`UsageOp.options` → `['parse','read','cross','tailor','research','rehearse']`), and `drizzle-orm` exports `count`, `countDistinct`, `sum`, `gte`, `isNull`, `sql` with `.mapWith()`. Use `UsageOp.options` rather than re-typing the six values.

**0.9 — Route groups are invisible in URLs.** `app/(admin)/admin/page.tsx` serves **`/admin`**. `middleware.ts`'s existing header comment and FND-09's `app/(app)/page.tsx` → E28 build failure both document this. The middleware gate must therefore match the pathname `/admin`, never a literal `(admin)` segment.

**0.10 — the existing middleware matcher already covers `/admin`.** `matcher: ['/((?!api/|_next/static|_next/image|favicon.ico).*)']` matches `/admin` and `/admin/anything`. **No matcher change is needed** — and none should be made.

---

## 1. Scope

### In scope (ticket Deliverables 1–3)

1. `lib/db/queries/admin.ts` — four aggregation functions over `usage_events` (+ `users`/`libraries`/`jobs`/`tailored_resumes`/`briefs` for the funnel), plus `lib/db/queries/admin.test.ts`.
2. `app/(admin)/admin/page.tsx` — server component rendering the four aggregate views, gated.
3. `middleware.ts` (append-only) — `/admin` requires an authenticated session **and** an `ADMIN_EMAILS`-allowlisted email.
4. `app/(admin)/_lib/admin-access.ts` — the single definition of "is this email an admin", imported by both #2 and #3 (see §2.1 for why it is a separate file and the file-scope note that goes with it).
5. `.env.example` (append-only) — `ADMIN_EMAILS` placeholder.
6. Test files: `lib/db/queries/admin.test.ts`, `app/(admin)/_lib/admin-access.test.ts`, `app/(admin)/admin/page.test.tsx`, and appended cases in the existing root `middleware.test.ts`.

### Explicitly out of scope

- **No APM / third-party analytics / external dashboard.** PRD §8.4 "不上 APM"; §8.3 "v1 不接第三方分析". Adding any SDK here fails the module-level acceptance item.
- **No real-time / auto-refresh / polling.** Query-per-page-load only (ticket Non-goals).
- **No per-user drill-down, and no function in `admin.ts` may return row-level or user-identifying data** (no email, name, `userId`, job title, company). PRD §8.4 authorizes aggregates only; a per-user view is new privacy surface requiring a product decision (ticket Non-goals).
- **No role/permission system**: no `isAdmin` column, no migration, no new table. `db/schema.ts` and `db/migrations/**` are **not touched** by this ticket.
- **No change to `lib/usage/record.ts`** (FND-10's write path) and no change to any `usage_events` column. If a required view turns out to be uncomputable, that is Feedback obligation #3 → escalate (§5 Q3), do not invent a parallel table.
- **No change to `app/layout.tsx`** — no `/admin` nav link (01-foundation file-scope; and a nav entry shown to every user is wrong for an internal page).
- **No change to `middleware.ts`'s `PUBLIC_PATHS`, its `config.matcher`, or its existing redirect behavior** (§0.10). Append only.
- **No change to `vitest.config.ts`** — verified: `lib/**/*.test.ts` covers `lib/db/queries/admin.test.ts`; `app/**/*.test.{ts,tsx}` covers both new `app/(admin)/**` tests; `*.test.ts` covers root `middleware.test.ts`. Every new test file is already discovered. (This repo has repeatedly shipped false greens by adding tests to an unmatched path — FND-02/05/06/08/09, EVL-01/02 each had to fix it. Not needed here; confirm your files land in those globs.)
- **No `03`–`06` files, no `lib/db/queries/library.ts`, no `db/index.ts`, no `package.json` dependency** (nothing here needs a new package).

---

## 2. Change list

### 2.1 `app/(admin)/_lib/admin-access.ts` — NEW (the gate's single definition)

**File-scope note (record this, don't bury it):** the ticket's literal File-scope lists `app/(admin)/admin/page.tsx` and `app/(admin)/admin/_components/**`. `docs/prd/breakdown-plan.md` §3 allocates **`app/(admin)/**`** wholesale to `07-platform-launch`, so this path is inside the module's ownership but outside the ticket's literal enumeration. Same class of gap PLT-02 recorded for `.github/scripts/backup.mjs`. Record it in the ticket Changelog and flag it to the Reviewer.

**Why a separate file rather than inlining the check twice:** the identical predicate is needed in two runtimes (Edge middleware, Node server component). Two copies is how one of them silently drifts. `_lib` is a Next.js private folder (leading underscore) — never routable. Precedent for `@/app/(…)/…` imports with parentheses: `app/(app)/settings/page.tsx` already imports `@/app/(app)/settings/_components/delete-account-confirm`, and page tests import `@/app/(legal)/privacy/page` — the `@/*` tsconfig path and the vitest `@` alias both resolve them.

Illustrative shape (Builder implements; do not copy verbatim without reading the notes):

```ts
// PRD names NO admin-authorization mechanism. This env-var email allowlist is
// 07-platform-launch/README.md's decision-table choice + open question #1
// (owner: Horace, pending confirmation) — see docs/plans/PLT-03.md §5 Q1.

/** Parsed ADMIN_EMAILS. Read at CALL time, never cached at module scope. */
function adminEmails(): string[] {
  // Literal static key: Next.js inlines `process.env.X` into the Edge bundle only
  // for statically-analyzable keys — `process.env[k]` would break in middleware.
  return (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;              // no session email -> deny
  const allowlist = adminEmails();
  if (allowlist.length === 0) return false; // unset/blank ADMIN_EMAILS -> deny ALL
  return allowlist.includes(email.trim().toLowerCase());
}
```

Non-negotiable properties (each has a test in §3.2):

1. **Fail closed.** Unset, empty, whitespace-only, or `","`-only `ADMIN_EMAILS` ⇒ nobody is an admin. Never "no allowlist configured means everyone".
2. **Never throw.** `process.env.ADMIN_EMAILS` is `undefined` when unset; `undefined.split(',')` would throw *inside middleware*, i.e. a 500 on every `/admin` request. Use `?? ''`.
3. **Blank entries are filtered before comparison.** `''.split(',')` is `['']`; without the `.filter()`, a session whose email is `''` would match the empty allowlist entry.
4. **Trim + lowercase both sides.** Env values acquire stray spaces after commas; providers vary the case they hand back. This *widens* the match set (`Horace@x.com` matches `horace@x.com`) — that is the deliberate, standard trade-off; it prevents a lockout, and the mailbox itself is still the authentication factor (Google OAuth verifies it; the Resend magic link proves control of it).
5. **`email` param accepts `string | null | undefined`** — `next-auth`'s `Session['user'].email` is `string | null | undefined` under this repo's `auth.config.ts` session callback (which returns `session.user.email` verbatim).
6. **No DB, no React, no `next/*` import** — must stay Edge-safe and import-safe with no environment at all.

### 2.2 `middleware.ts` — APPEND ONLY (01-foundation file-scope; ticket authorizes this append)

Current handler (read it before editing) is: `PUBLIC_PATHS` short-circuit → `!req.auth` ⇒ redirect `/signin` → `NextResponse.next()`. Insert the admin check **after** the auth check and **before** the final `next()`, so an unauthenticated `/admin` request keeps redirecting to `/signin` exactly as today.

```ts
import { isAdminEmail } from '@/app/(admin)/_lib/admin-access';

// PLT-03: /admin is served by app/(admin)/admin/page.tsx. Route groups are
// invisible in request URLs (see this file's header comment), so "gate
// app/(admin)/**" is implemented as a pathname test on '/admin'.
// SEGMENT-SCOPED on purpose, exactly like the `api/` lookahead in config.matcher
// (FND-08 Reviewer finding #3): a bare startsWith('/admin') would also swallow a
// future '/administrators' page.
function isAdminPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/');
}

// …inside the handler, after the `if (!req.auth) { … }` block:
if (isAdminPath(pathname) && !isAdminEmail(req.auth.user?.email)) {
  return new NextResponse('Forbidden', { status: 403 });
}
```

- **403, not a redirect.** The ticket allows either ("redirect/403"); 403 is chosen because it is unambiguous in a test, cannot loop, and does not bounce an already-authenticated user to a sign-in page they are already past. Keep the body a bare `'Forbidden'` string — no diagnostics, no echo of the email.
- Do **not** add `/admin` to `PUBLIC_PATHS`. Do **not** touch `config.matcher` (§0.10).
- `req.auth.user?.email` — `req.auth` is already narrowed to non-null by the preceding guard; keep the `?.` on `user`.

### 2.3 `lib/db/queries/admin.ts` — NEW (Deliverable 1)

Create `lib/db/queries/` (§0.7). Module header must state, in prose, all four of:

1. **This is the ONE deliberate exception to PRD §8.3's "全部查询以 session userId 约束".** Every query here is intentionally cross-user. It is safe *only* because its callers are admin-gated. **Never import this module from a user-facing route or page.**
2. **Aggregates only.** No function returns a row, an email, a name, a `userId`, a company, or a job title. Adding a per-user view is a product decision (ticket Non-goals), not a refactor.
3. **Build-time safety** (see below) — no top-level `@/db/index` import.
4. Reads only; this module never writes.

**Build-time safety — copy this pattern exactly.** `db/index.ts` throws at import time when `DATABASE_URL` is unset (an intentional, tested FND-05 fail-fast), and `next build`'s "Collecting page data" phase statically imports every page module. §2.4's page imports this module directly, so a top-level `import { db } from '@/db/index'` here would break `pnpm build` on any checkout/CI without `DATABASE_URL` (§0.5's baseline). Note `lib/config/quota.ts` and `lib/usage/record.ts` *do* import `@/db/index` statically — that is safe only because nothing under `app/**` imports *them*. This module is in the other category.

```ts
// Memoized so ONE module instance issues EXACTLY ONE import('@/db/index') and
// concurrent callers await the same promise. This is load-bearing, not a
// micro-optimization: vitest's mocker re-resolves a vi.doMock-ed specifier on
// every import() call, and two import()s issued in the same tick race — one gets
// the mock, the other loads the REAL module and dies on the DATABASE_URL
// fail-fast. §2.4's page calls all four functions inside one Promise.all, which
// is exactly that same-tick concurrency. (Identical reasoning is documented in
// lib/db/queries/library.ts, LIB-02.) A rejected import is NOT cached.
let dbIndexPromise: Promise<typeof import('@/db/index')> | null = null;
function dbIndex(): Promise<typeof import('@/db/index')> {
  dbIndexPromise ??= import('@/db/index').catch((err: unknown) => {
    dbIndexPromise = null;
    throw err;
  });
  return dbIndexPromise;
}
async function defaultDb() {
  const { db } = await dbIndex();   // read-only work: the neon-http `db`, never `dbTx`
  return db;
}
```

`@/db/schema` and `drizzle-orm` are connection-free and are imported statically.

**Shared window helper.** `usage_events.createdAt` is `bigint(mode:'number')` epoch-ms (`db/schema.ts` convention #1), so the window filter is a plain numeric `gte` — the same shape `lib/config/quota.ts` already uses (`gte(usageEvents.createdAt, startOfDay)`).

```ts
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Inclusive lower bound of the 7-day window (ticket: "createdAt >= <7 days ago>"). */
function weekAgo(nowMs: number): number { return nowMs - WEEK_MS; }
```

Every windowed function takes an **optional** `nowMs: number = Date.now()` — additive, so the ticket's zero-argument call shape is unchanged, and boundary tests become exact instead of racing the wall clock. **Do not reach for `vi.useFakeTimers()`** to get determinism instead: PGlite drives a WASM runtime through async scheduling and its interaction with faked timers is unverified in this repo; the parameter costs nothing and removes the question.

#### `getWeeklyCost(nowMs = Date.now()): Promise<number>`

Structurally identical to the already-merged `checkGlobalBreaker()` in `lib/config/quota.ts:156-164` — reuse its exact idiom:

```ts
const [row] = await db
  .select({ total: sum(usageEvents.costUsd) })
  .from(usageEvents)
  .where(gte(usageEvents.createdAt, weekAgo(nowMs)));
return Number(row?.total ?? 0);   // SUM over numeric -> string; over 0 rows -> NULL
```

`Number(null ?? 0)` is `0`, never `NaN` (quota.ts documents this). Returns USD, not cents.

#### `getLatencyPercentiles(nowMs = Date.now()): Promise<Record<UsageOp, OpLatency>>`

```ts
export type OpLatency = { p50: number; p95: number; samples: number };
```

**Documented additive deviation from the ticket's literal `{ p50: number; p95: number }`.** Every value still has `p50` and `p95`, so the ticket's contract is satisfied; `samples` is added because there is otherwise **no honest value** for an op with zero events in the window — `{p50: 0, p95: 0}` asserts "this operation completed in 0 ms", which is affirmatively false and directly contrary to PRD §5.5's "宁可暴露不完整，不静默吞掉". `samples` lets §2.4 render `—`. (Contrast §2.3's funnel function, whose shape is *not* widened: a ratio over a small denominator is still arithmetically correct, only statistically weak — a different problem, handled with a page-level caveat instead. State this asymmetry in the ticket Changelog; a Reviewer will ask.)

```ts
const rows = await db
  .select({
    op: usageEvents.op,
    p50: sql<number>`percentile_disc(0.5) within group (order by ${usageEvents.durationMs})`.mapWith(Number),
    p95: sql<number>`percentile_disc(0.95) within group (order by ${usageEvents.durationMs})`.mapWith(Number),
    samples: count(),
  })
  .from(usageEvents)
  .where(gte(usageEvents.createdAt, weekAgo(nowMs)))
  .groupBy(usageEvents.op);
```

Then fold into a **complete** record over `UsageOp.options` (§0.8), defaulting absent ops to `{ p50: 0, p95: 0, samples: 0 }`.

- `percentile_disc`, not `percentile_cont` — §0.1. Semantics to document in a code comment: for the ascending durations of one op, `percentile_disc(q)` returns the value at rank `k = ceil(q * n)`, i.e. a real observed latency, integer milliseconds.
- `.mapWith(Number)` on both percentile expressions — §0.4. Not optional.
- `count()` (drizzle's, which maps to Number) — do not hand-roll `sql\`count(*)\``.
- Ops with no rows do not appear in `rows` at all; that is what the fold handles.
- **Vocabulary warning for the page:** `usage_events.op` is the pipeline-STAGE vocabulary (`parse|read|cross|tailor|research|rehearse`). PRD §7's latency budgets (Fit ≤30s / Tailor ≤45s / Prep ≤90s) are **user-facing-action** vocabulary and are *not* the same thing — `lib/config/quota.ts:34-65` documents the mapping and why it is lossy (a Fit is `read` + `cross`, two rows). Do **not** label an op's p50 as a Fit/Prep budget, and do not sum ops into actions here.

#### `getDroppedRate(nowMs = Date.now()): Promise<number>`

Ticket formula: `SUM(droppedCount) / COUNT(*)`. **Select the two aggregates and divide in JS** — §0.2 (bigint/bigint truncates to 0 in SQL) and §0.3 (division by zero raises).

```ts
const [row] = await db
  .select({ dropped: sum(usageEvents.droppedCount), events: count() })
  .from(usageEvents)
  .where(gte(usageEvents.createdAt, weekAgo(nowMs)));
const events = Number(row?.events ?? 0);
return events === 0 ? 0 : Number(row?.dropped ?? 0) / events;
```

**Name it honestly in the UI.** This is *dropped items per operation*, not a percentage: the denominator is the number of usage events, because `usage_events` has no "items considered" column. PRD §6's Q1 gate ("dropped < 15%") and `eval/assertions/q1.ts:98-104` (`droppedCount / totalCount`, where `totalCount` is the number of **items**) compute a genuinely different number. Rendering this as "Dropped rate: 55%" invites a direct false comparison against the 15% gate. §2.4 fixes the label; §5 Q3 carries the question of whether Horace wants a true rate (which needs an `usage_events` column extension — the ticket's own Feedback obligation #3).

#### `getFunnelConversion(): Promise<{ signupToLibrary; fitToTailor; interviewingToBrief }>`

**All-time, not windowed** — the ticket's definitions name no window (unlike the other three, which say "the same 7-day window"), and PRD §7's activation/conversion targets are cumulative. Take no `nowMs`. §2.4 must label the section "all time" so the difference from the 7-day sections is visible. (§5 Q2 carries "should the funnel be windowed too?" to Horace.)

Six scalar sub-queries, three JS divisions, one zero-denominator branch each. A shared local helper keeps it honest:

```ts
const ratio = (numerator: number, denominator: number) =>
  denominator === 0 ? 0 : numerator / denominator;
```

1. **`signupToLibrary`** = distinct users with a usable library ÷ registered users.
   - denominator: `count()` over `users`.
   - numerator: `countDistinct(libraries.userId)` over `libraries` where
     `isNull(libraries.deletedAt)` **and** `` sql`jsonb_typeof(${libraries.projects}) = 'array' and jsonb_array_length(${libraries.projects}) > 0` `` (verified working in PGlite at planning time).
   - `countDistinct`, not `count`: `libraries.userId` has only a plain btree index, **no UNIQUE constraint** — LIB-02's header documents that two concurrent confirms can produce duplicate rows. Counting rows would then overstate the numerator and could exceed 1.0.
   - `isNull(deletedAt)`: PRD §5.6 soft delete; a tombstoned library is not a built library.
   - non-empty `projects`: matches the ticket's `projects.length > 0` **and** LIB-02's `hasLibrary()` semantics (PRD §5.7 "无库时禁止新建 job"). `jsonb_typeof` guard first — `jsonb_array_length` errors on a non-array value.
2. **`fitToTailor`** = distinct jobs with a `tailored_resumes` row ÷ jobs.
   - denominator: `count()` over `jobs`. Add a code comment: `jobs.fit` is `NOT NULL` in `db/schema.ts` (FND-04's atomicity guarantee — a Job only exists once READ+CROSS+SCORE all produced output), so "jobs with `fit` populated" is *every* job. Do **not** add a `fit IS NOT NULL` filter that implies otherwise.
   - numerator: `countDistinct(tailoredResumes.jobId)` over `tailored_resumes` — its `jobId` FK (`onDelete: 'cascade'`) guarantees every row points at a live job, so no join is required.
3. **`interviewingToBrief`** = interviewing jobs that have a brief ÷ interviewing jobs.
   - denominator: `count()` over `jobs` where `eq(jobs.status, 'interviewing')`.
   - numerator: `countDistinct(jobs.id)` over `jobs` `innerJoin(briefs, eq(briefs.jobId, jobs.id))` where `eq(jobs.status, 'interviewing')`. The status filter must be on the **jobs** side — counting briefs alone would include briefs on jobs that have since moved to `closed`.

Return raw ratios in `[0, 1]` (the page formats percentages). Every one of the six sub-queries returns a plain count — nothing identifying, per §2.3 header rule 2.

### 2.4 `app/(admin)/admin/page.tsx` — NEW (Deliverable 2)

**Path is exact.** `app/(admin)/admin/page.tsx` → `/admin`. Do **not** create `app/(admin)/page.tsx`: it resolves to `/` and collides with `app/page.tsx`, failing `next build` with Next's E28 "two parallel pages resolve to the same path" — the precise mistake FND-09 hit and documented.

```tsx
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin — Groundwork' };

export default async function AdminPage() {
  const session = await auth();                      // @/auth
  if (!isAdminEmail(session?.user?.email)) notFound(); // next/navigation
  const [weeklyCostUsd, latency, droppedPerOp, funnel] = await Promise.all([
    getWeeklyCost(), getLatencyPercentiles(), getDroppedRate(), getFunnelConversion(),
  ]);
  // …render…
}
```

- **`export const dynamic = 'force-dynamic'` is required, not decorative.** It is what keeps `next build` from prerendering a page whose render path reaches `auth()` → `buildAuthConfig()` → `@/db/index` → the `DATABASE_URL` fail-fast. The root layout already forces dynamic for the whole tree (§0.5), so this is belt-and-suspenders — exactly the reasoning `app/layout.tsx:6-11` records for itself. Keep it and keep a one-line comment saying why.
- **The gate runs before any query — this ordering is a security requirement, and §3.4 tests it.** Defense in depth: middleware is the first line, but it is a *separate* runtime with its own env semantics (§4 R2/R3) and a documented history of framework-level bypass classes. A server component that computes cross-user aggregates must not depend solely on it.
- **`notFound()`, not a redirect or a rendered "forbidden" page**: it returns 404 and renders nothing, so an authenticated non-admin who somehow reaches the RSC gets no aggregate byte. (Middleware's 403 already answers "does this path exist"; the page's job is to leak no *data*.)
- Sections to render (a plain table/`<dl>` layout — PRD names no visual design for this internal tool; no CSS framework, inline styles like the sibling PLT-01 pages):
  1. **`Weekly cost (last 7 days)`** — `$` + `weeklyCostUsd.toFixed(4)`. Four decimals, deliberately: PRD §9's per-operation costs are ~$0.01–$0.30, so `toFixed(2)` renders a real early week as `$0.00`.
  2. **`Latency by pipeline stage (last 7 days)`** — table `op | p50 (ms) | p95 (ms) | samples`, one row per `UsageOp.options` entry, in that order. `samples === 0` ⇒ render `—` in p50/p95, never `0`. Add a one-line note that these are pipeline stages, not the Fit/Tailor/Prep budgets of PRD §7 (§2.3's vocabulary warning).
  3. **`Dropped items per operation (last 7 days)`** — the raw number, e.g. `0.75`, **not** a `%`. One-line note: "average dropped items per usage event — not the Q1 eval gate's dropped rate (PRD §6), which divides by items considered."
  4. **`Funnel conversion (all time)`** — three rows, each `label | value% | PRD §7 target`: signup → library (`≥ 50%`), fit → tailor (`≥ 25%`), interviewing → brief (`≥ 60%`). Format with `(r * 100).toFixed(1) + '%'`. Add a one-line honesty note: PRD §7 says these targets are recalibrated after two weeks of real data, and a ratio over a handful of users is noise.
- **Number formatting must be locale-independent** — use `toFixed`, not a bare `Intl.NumberFormat()` with no explicit locale, so the rendered string cannot depend on the server's locale.
- No `'use client'`, no client component, no `_components/**` needed unless you genuinely split a table out; nothing on this page is interactive.
- **Do not `try/catch` the queries into a fake zero page.** If a query throws, let the error boundary show a failure — a silently-zeroed cost dashboard is worse than a broken one.

### 2.5 `.env.example` — APPEND ONLY

Append below the existing runtime keys, above PLT-02's commented `R2_*` GitHub-Actions block (which is explicitly *not* a runtime `.env.local` key — keep that distinction intact):

```
# Comma-separated allowlist of admin emails for /admin (PLT-03). Unset or blank
# = nobody has access (fail closed). Example: ADMIN_EMAILS=you@example.com,ops@example.com
ADMIN_EMAILS=
```

`.env.example` is 01-foundation file-scope; append-only is permitted by `breakdown-plan.md` §3 and this append is named in the ticket's own File-scope.

### 2.6 Files that must NOT change

`db/schema.ts`, `db/migrations/**`, `db/index.ts`, `lib/usage/record.ts`, `lib/config/**`, `lib/db/queries/library.ts`, `auth.ts`, `auth.config.ts`, `lib/auth/session.ts`, `app/layout.tsx`, `app/page.tsx`, `vitest.config.ts`, `package.json`, `eslint.config.mjs`, anything under `app/api/**`, and every `03`–`06` path. If you believe you need one of these, stop and escalate — that is a plan defect, not a Builder judgment call.

---

## 3. Test plan

Suite must end green: `pnpm test` (`vitest run`). Every acceptance item below is `[machine]`.

**Shared PGlite discipline (applies to `lib/db/queries/admin.test.ts`):**

- Boot **one** PGlite in `beforeAll` and run the real committed migrations: `migrate(db, { migrationsFolder: './db/migrations' })` — the same code path production runs (precedent: `lib/db/queries/library.test.ts:36-42`, `app/api/account/delete/route.test.ts:28-35`).
- **ISS-29 timeout:** PGlite boot + the migration chain exceeds Vitest's 5000 ms default under full-suite load. Pass `30_000` as the **third argument** to `beforeAll` and to **every** `it()` in the file. A task's timeout is resolved at collection time, so `vi.setConfig`/`vi.useFakeTimers` inside a hook is a silent no-op — this is the exact bug ISS-29 had to bounce-fix. Copy `library.test.ts:30`'s `PGLITE_TEST_TIMEOUT_MS` constant.
- **TRUNCATE between tests — this is the single most important difference from `library.test.ts`.** That file gets isolation for free because every query is `userId`-scoped and each test mints a fresh user. **These aggregations are global**: rows seeded by test A change test B's expected numbers, so the "fresh user per test" pattern would produce tests that pass alone and fail as a suite (or worse, pass now and break when someone adds a test later). Add a `beforeEach` that truncates: `truncate table users, libraries, resumes, jobs, tailored_resumes, briefs, usage_events restart identity cascade;` (via the raw PGlite client's `.exec()`, or `db.execute(sql\`…\`)`). Do not create a fresh PGlite per test (≈1.5 s each — that is the cost ISS-29 was filed about).
- Module loading: `vi.resetModules(); vi.doMock('@/db/index', () => ({ db: client })); await import('@/lib/db/queries/admin');` — the module under test resolves `@/db/index` lazily, and the real one throws without `DATABASE_URL`. `admin.ts` needs only the `db` export (reads only, no `dbTx`).
- Fixtures for `jobs` / `tailored_resumes` / `briefs` have NOT NULL jsonb columns (`jd`, `ledger`, `fit`, `alignment`, `edits`, `rehearse`). **Copy the minimal Zod-valid literals from `app/api/account/delete/route.test.ts:49-91`** rather than inventing new ones.

### 3.1 `lib/db/queries/admin.test.ts` — acceptance items 1, 2, 3

Fix `const NOW = 1_800_000_000_000` (any constant) and pass it as `nowMs`; seed `createdAt` relative to it.

**(a) `getWeeklyCost` — window correctness [acceptance 1].** Seed `usage_events`:

| createdAt | costUsd | in window? |
|---|---|---|
| `NOW` | 0.10 | yes |
| `NOW - 1_000` | 0.02 | yes |
| `NOW - WEEK_MS` (exact boundary) | 0.005 | **yes** — bound is inclusive (`>=`) |
| `NOW - WEEK_MS - 1` | 99.0 | no |
| `NOW - 30 * DAY_MS` | 42.0 | no |

Assert `expect(await getWeeklyCost(NOW)).toBeCloseTo(0.125, 10)` (`toBeCloseTo`, not `toBe` — `numeric` arrives as a string and is coerced through float). Separate test: empty table ⇒ exactly `0` (not `NaN`, not `null`).

**(b) `getLatencyPercentiles` — deterministic percentiles [acceptance 2].** Expected values follow from the nearest-rank rule `k = ceil(q * n)` over ascending values (§0.1), so they are derivable from the plan, not copied from the implementation:

- op `parse`: 10 in-window rows, `durationMs` = 100,200,…,1000 ⇒ `p50 = 500` (k=5), `p95 = 1000` (k=10), `samples = 10`.
- op `tailor`: 3 in-window rows, 100/200/300 ⇒ `p50 = 200` (k=2), `p95 = 300` (k=3), `samples = 3`.
- op `cross`: 1 row at `NOW - WEEK_MS - 1` with `durationMs = 9_999` ⇒ excluded ⇒ `{ p50: 0, p95: 0, samples: 0 }` (proves the window filter applies per-op).
- ops `read`, `research`, `rehearse`: no rows ⇒ `{ p50: 0, p95: 0, samples: 0 }`.
- Assert the returned object has **exactly** the six `UsageOp.options` keys.
- Assert `p50`/`p95` are `typeof === 'number'` (guards the `.mapWith(Number)` requirement of §0.4 — a driver-returned string would still pass a loose `==` comparison).

**(c) `getDroppedRate`.** Four in-window rows with `droppedCount` 3/0/0/0 plus one out-of-window row with `droppedCount = 100` ⇒ `0.75`. This value is also the §0.2 regression guard: an SQL-side `sum/count` would return `0`. Second test: empty table ⇒ `0` (no throw — §0.3). Third: all-zero `droppedCount` over 3 rows ⇒ `0`.

**(d) `getFunnelConversion` — hand-computed [acceptance 3].** Seed exactly:

- Users `u1..u4` (4 rows).
- `libraries`: `u1` → `projects: [project]`; `u2` → `projects: []`; `u3` → `projects: [project]` **with `deletedAt` set**; `u4` → none.
  ⇒ `signupToLibrary = 1/4 = 0.25` (matches the ticket's own worked example; also proves the empty-projects and soft-delete exclusions).
- `jobs`: `j1(u1, screening)`, `j2(u1, interviewing)`, `j3(u2, interviewing)`, `j4(u3, closed)` (4 rows).
- `tailored_resumes`: on `j1` only ⇒ `fitToTailor = 1/4 = 0.25`.
- `briefs`: on `j2` (interviewing) **and** on `j4` (closed — this row is what proves the status filter lives on the jobs side) ⇒ interviewing jobs = {j2, j3} = 2, of which with a brief = {j2} = 1 ⇒ `interviewingToBrief = 0.5`.

Separate test: empty database ⇒ all three exactly `0`, no throw (§0.3). Optional but cheap: insert a duplicate `libraries` row for `u1` and assert `signupToLibrary` stays `0.25` (the `countDistinct` guard).

### 3.2 `app/(admin)/_lib/admin-access.test.ts` — the allowlist predicate

Plain unit test, no DB, no jsdom. Use `vi.stubEnv('ADMIN_EMAILS', …)` and `vi.unstubAllEnvs()` in `afterEach`. Cases: exact match ⇒ true; second entry in the list ⇒ true; unlisted ⇒ false; **unset ⇒ false**; `''` ⇒ false; `',,'` ⇒ false; `' a@x.com , b@y.com '` (spaces) ⇒ both true; `'Admin@X.com'` in env vs `'admin@x.com'` session (and vice versa) ⇒ true; `null`/`undefined`/`''` email ⇒ false **even when the env var is blank** (the `['']` trap); does not throw for any of the above.

### 3.3 `middleware.test.ts` — APPEND [acceptance 4: the two required integration tests]

Append to the existing root file (which mocks `@/auth` as a pass-through and invokes the handler directly with a `fakeReq(pathname, auth)` — reuse its helpers verbatim; do not restructure it). `vi.stubEnv` works without `resetModules` **because** §2.1 reads `process.env` at call time; if you cache it at module scope these tests silently pass against a stale value.

Required:

1. `/admin` + session `{ user: { id: 'u1', email: 'nobody@example.com' } }`, `ADMIN_EMAILS='admin@example.com'` ⇒ `res.status === 403`.
2. `/admin` + session `{ user: { id: 'u1', email: 'admin@example.com' } }`, same env ⇒ pass-through (`x-middleware-next === '1'`, no redirect).

Also append (each guards a specific failure mode named in §4):

3. `/admin` unauthenticated (`auth: null`) ⇒ still redirects to `/signin` (existing behavior preserved).
4. `/admin` + allowlisted-looking email but `ADMIN_EMAILS` **unset** ⇒ 403 (fail closed, R1).
5. `/admin/usage` (sub-path) + non-admin ⇒ 403 (the gate is not `/admin`-exact-only).
6. `/administrators` + authenticated non-admin ⇒ **not** 403, passes through (segment-scoped prefix, R5 — same bug class as FND-08 Reviewer finding #3).
7. `/settings` + authenticated non-admin ⇒ unchanged pass-through (the append gates nothing else).
8. Matcher regression: the existing `re` from the matcher describe-block matches `/admin` and `/admin/usage` (§0.10).

### 3.4 `app/(admin)/admin/page.test.tsx` — the page

`// @vitest-environment jsdom` + `afterEach(cleanup)` (this repo does not enable vitest globals — precedent `app/(app)/settings/page.test.tsx`, `app/(legal)/privacy/page.test.tsx`). Mock `@/auth` (`vi.hoisted` fn, as `app/api/account/delete/route.test.ts:19-24` does) and `vi.mock('@/lib/db/queries/admin', …)` with the four functions returning fixed values. The component is `async`, so render it as `render(await AdminPage())`.

1. **Admin session** ⇒ renders an `h1`, the weekly-cost figure, a latency row per op with `—` for a zero-`samples` op, the dropped-items figure, and the three funnel percentages with their PRD §7 targets.
2. **Security test (do not skip):** session email NOT in `ADMIN_EMAILS` ⇒ `AdminPage()` rejects (`notFound()` throws Next's 404 control-flow error) **and every one of the four query mocks was never called** (`expect(getWeeklyCost).not.toHaveBeenCalled()` …). This is what proves the gate precedes data access (§2.4).
3. **No session at all** (`auth()` ⇒ `null`) ⇒ same rejection, same "no query was called" assertion.
4. Rendered text contains no email address (`expect(container.textContent).not.toMatch(/@example\.com/)`) — the aggregates-only invariant, mirroring `app/(legal)/privacy/page.test.tsx:33-39`'s guard.

### 3.5 Build check [acceptance 5 companion]

Run `pnpm build` with **no** `DATABASE_URL` and no `AUTH_*` and confirm exit 0 and that `/admin` appears as `ƒ (Dynamic)` in the route table. §0.5 is the baseline; this is the only way to catch a top-level `@/db/index` import in `admin.ts` before CI does.

---

## 4. Risks & edge cases

Security-sensitive and concurrency items first, as the Reviewer will check these.

**R1 — [security, high] Fail-open allowlist.** If `ADMIN_EMAILS` is unset in production and the predicate is written as "no allowlist ⇒ allow", every signed-in user reads global cost and funnel data. §2.1 property 1 + §3.2 + §3.3 case 4 exist for exactly this. Related: an unguarded `process.env.ADMIN_EMAILS.split(',')` **throws inside middleware** — that fails closed but 500s, and a `catch` added later to "fix the 500" is the classic path to failing open.

**R2 — [security, medium] The middleware gate is necessary but not sufficient.** It runs in a different runtime, its env value may be build-inlined (R3), and Next.js middleware has a documented history of framework-level bypass classes (this repo pins `next ^15.5.20`, which is past the known `x-middleware-subrequest` fix, but the architectural point stands). The page-level `isAdminEmail` check in §2.4 is the authoritative gate; middleware is the early, cheap one. **Do not "simplify" by deleting the page-level check** because "middleware already handles it".

**R3 — [operational, medium] `ADMIN_EMAILS` in the Edge runtime.** Next.js statically inlines `process.env.<LITERAL>` into the middleware bundle; a dynamic `process.env[key]` lookup does not work there at all. Consequence to expect and to write in a code comment: **changing `ADMIN_EMAILS` may require a redeploy, not just an env-var edit**, and this cannot be verified offline (no live Vercel deployment exists yet — sub-PRD open question #3). The page-level check runs in the Node runtime and reads `process.env` at request time, so the authoritative gate is the one with the simpler env semantics. Never construct the key dynamically.

**R4 — [inherited, medium] `auth()` inside Edge middleware under `session: { strategy: 'database' }` is still unverified in this repo.** `middleware.ts:48-51` carries FND-08's commented-out `runtime: 'nodejs'` escape hatch for precisely this. If `req.auth` comes back null or without `user.email` on Edge, the admin gate denies (fail closed) — acceptable — but so does the whole authenticated app, which would be an FND-08-level infra bug, not a PLT-03 bug. Do not "fix" it inside this ticket; report it.

**R5 — [security, medium] Prefix vs segment matching.** `pathname.startsWith('/admin')` also matches `/administrators`, `/adminfoo`. Use the exact `=== '/admin' || startsWith('/admin/')` form (§2.2) — the same finding FND-08's Reviewer raised about the `api/` lookahead, and §3.3 case 6 pins it.

**R6 — [privacy, medium] Aggregate-only invariant.** Every function in `admin.ts` returns counts/sums. A future "which user is burning the budget?" tweak crosses into per-user inspection, which the ticket's Non-goals forbid without a product decision (resumes are PII; PRD §8.3/§12 name PII leakage as a top-2 risk). §2.3 header rule 2 + §3.4 case 4 are the guards.

**R7 — [correctness, high] Integer division and division by zero.** §0.2/§0.3. Both dodged by dividing in JS with an explicit zero-denominator branch. A Builder who "optimizes" the ratio back into SQL reintroduces both. Guarded by §3.1(c)'s `0.75`.

**R8 — [correctness, high] Un-mapped raw aggregates.** §0.4: `` sql<number>`…` `` without `.mapWith(Number)` returns numbers under PGlite and strings under Neon — green tests, `"500" + …` in production. Guarded by §3.1(b)'s `typeof` assertion.

**R9 — [test integrity, high] Cross-test pollution.** Global aggregates + a shared PGlite ⇒ order-dependent tests. §3's TRUNCATE-per-test rule. Symptom if ignored: tests pass individually, drift as the file grows.

**R10 — [build, high] Static `@/db/index` import in `admin.ts`.** Breaks `pnpm build` on any env-less checkout (CI included) the moment a page imports it — the exact FND-08 v0.1 failure. §2.3's lazy memoized `dbIndex()` + §3.5.

**R11 — [concurrency, low] Four concurrent lazy imports.** `Promise.all` over the four functions issues four same-tick `dbIndex()` calls; the memo collapses them to one `import()`. Without the memo, vitest's mocker hands the real (throwing) `@/db/index` to one of the racers — verified and documented in LIB-02's header. Do not "simplify" the memo away.

**R12 — [correctness, medium] Concurrency/consistency of the four aggregates.** They are four independent statements with no snapshot isolation, so the page can render numbers computed microseconds apart. That is fine for this metric page (a full-page reload is the refresh model) — but do **not** paper over it by deriving one figure from another. Also: each windowed function calls `Date.now()` independently, so their windows differ by microseconds; harmless, and the `nowMs` parameter exists if a future caller wants one shared instant.

**R13 — [metric semantics, medium] "Dropped rate" is not the Q1 gate's dropped rate.** §2.3/§2.4. Mislabelling it invites a false comparison against PRD §6's 15% threshold. Fix is a label + a one-line note, plus §5 Q3.

**R14 — [metric semantics, low] `interviewingToBrief` is a point-in-time snapshot.** `jobs.status` is mutable: a job that generated a brief and then moved to `closed` leaves the numerator *and* the denominator. The ratio measures "of jobs currently in `interviewing`, how many have a brief" — a literal reading of PRD §7. Note it in a code comment; if it starts reading low for that reason, that is Feedback obligation #2 (a product-signal finding for Horace), not a bug to fix locally.

**R15 — [correctness, low] `jsonb_array_length` on a non-array** raises. Guarded by the `jsonb_typeof(...) = 'array'` conjunct (§2.3). The column is NOT NULL with a `[]` default and is only ever written as an array by LIB-02, so this is defense in depth against a drifted row — the same "loud beats silently-wrong" posture `getLibrary()` takes.

**R16 — [routing, medium] Route-group traps.** (a) `app/(admin)/page.tsx` collides with `app/page.tsx` (E28) — use the exact path in §2.4. (b) A literal `(admin)` string in the middleware path test would never match a real request (§0.9). (c) Files under `_lib`/`_components` are private folders and are never routed — that is why the helper may live inside `app/`.

**R17 — [cost, low] `getLatencyPercentiles` scans the 7-day window on every page load.** With PRD-scale traffic and the existing `usage_events_user_op_created_idx` composite index, this is irrelevant. Not a reason to add caching, a materialized view, or a new index in this ticket.

---

## 5. Open questions

| # | Question | Owner | Default this plan takes if unanswered |
|---|---|---|---|
| Q1 | **Is an env-var email allowlist the right admin-authorization mechanism?** PRD defines none; `07-platform-launch/README.md` open question #1 records it as pending Horace's confirmation, and the ticket's Feedback obligation #1 requires confirmation before or shortly after P5 launch. **ADR candidate** — it is the app's only privileged-access boundary and it is hard to reverse quietly (alternatives: an `isAdmin` column + migration, or a single hardcoded account). | **Horace** (product) | Implement the env-var allowlist as specified, gated at two layers, fail-closed. If Horace changes it: bump the ticket version +0.1, add a `07-platform-launch/README.md` changelog line, and change the implementation — do not treat this as settled. |
| Q2 | **Should the funnel section be windowed (e.g. last 7/30 days) instead of all-time?** The ticket's definitions name no window; PRD §7's targets read as cumulative. | **Horace** (product) | All-time, explicitly labelled "all time" so the difference from the 7-day sections is visible on the page. |
| Q3 | **Is "dropped items per operation" the number Horace actually wants,** or a true dropped *rate* comparable to PRD §6's Q1 < 15% gate? A true rate needs an "items considered" count that `usage_events` does not have — i.e. an FND-10 column extension, which the ticket's Feedback obligation #3 explicitly pre-authorizes as the right move (rather than a parallel aggregation table). | **Horace** (product), with the Builder supplying the note | Implement the ticket's literal formula, label it honestly as items-per-operation, and record the gap. Do **not** extend `usage_events` inside this ticket. |
| Q4 | **Should the funnel rows surface their denominators** (e.g. "25% (1/4)")? At MVP volumes a ratio without its denominator is easy to over-read; PRD §7 itself says the targets get recalibrated after two weeks of real data. Adding them widens `getFunnelConversion`'s return shape beyond the ticket's literal signature. | **Reviewer / Horace** at the next iteration | Keep the ticket's exact three-number shape; add a one-line honesty caveat on the page instead. (Contrast the `samples` field added to `getLatencyPercentiles` — see §2.3 for why that asymmetry is principled, not sloppy.) |
| Q5 | **Does `ADMIN_EMAILS` take effect at runtime on Vercel's Edge middleware, or only at build time?** (R3.) Unverifiable offline — no live deployment or credentials exist yet (sub-PRD open questions #2/#3). | **Horace** (infra), at first deploy | Document the redeploy caveat in a code comment; rely on the Node-runtime page check as the authoritative gate. |

---

## 6. Writeback obligations (Builder, before handing to the Reviewer)

1. Record every deviation in the ticket file's Changelog **and** in `docs/prd/07-platform-launch/README.md`'s changelog (next version, `v0.5`), per this repo's PLT-01/PLT-02 precedent. The ones this plan already knows about:
   - `app/(admin)/_lib/admin-access.ts(+.test.ts)` — inside `breakdown-plan.md` §3's `app/(admin)/**` allocation, outside the ticket's literal File-scope enumeration (§2.1).
   - `middleware.test.ts` append — the acceptance checklist mandates the two gate tests; the file is 01-foundation-owned and append-only (same handling PLT-01 recorded).
   - `getLatencyPercentiles` returns `{ p50, p95, samples }` — additive superset of the ticket's literal value shape, with the §2.3 rationale.
   - The optional `nowMs` parameter on the three windowed functions.
   - Funnel = all-time (Q2); dropped metric labelled as items-per-operation (Q3).
2. Flag Q1 to the Reviewer explicitly as an unconfirmed product decision carried by this ticket, per Feedback obligation #1.
3. Report anything from §4 R4 (Edge `auth()`) or §0.6 (broken eslint plugin) that you hit — both are pre-existing, neither is yours to fix here.
