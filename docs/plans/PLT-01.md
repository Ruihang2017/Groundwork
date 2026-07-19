# PLT-01 — Implementation Plan

Privacy policy, ToS pages, and account hard-delete.

Ticket: `docs/prd/07-platform-launch/tickets/PLT-01-privacy-tos-account-delete.md`
Sub-PRD: `docs/prd/07-platform-launch/README.md`
Master spec: `docs/PRD.md` §5.6, §8.3, §8.4, §3 C5, §12
Depends on (merged): FND-05 (`db/schema.ts`, `db/index.ts`, `db/migrations/**`), FND-08 (`auth.ts`, `auth.config.ts`, `middleware.ts`, `lib/auth/session.ts`)

This plan was produced by reading the ticket, the sub-PRD, `docs/prd/breakdown-plan.md`, `docs/plans/FND-05.md`/`FND-08.md` (including their Changelog sections, which record what was *actually* built, not just what was originally speced), and the current state of `db/schema.ts`, `db/index.ts`, `auth.ts`, `auth.config.ts`, `middleware.ts`, `lib/auth/session.ts`, `lib/config/quota.ts`, `lib/usage/record.ts`, and their test files. It also verified two load-bearing technical facts directly against the installed dependency source (not assumed):

1. `drizzle-orm/neon-http`'s `db.transaction()` **unconditionally throws** `"No transactions support in neon-http driver"` (`node_modules/drizzle-orm/neon-http/session.js:151-159`). `db/index.ts`'s current `db` export uses exactly this driver.
2. Running `pnpm build` on a clean checkout with **zero env vars set** (no `DATABASE_URL`, no `AUTH_*`, no `ANTHROPIC_API_KEY`) currently **succeeds** (verified by actually running it). This baseline only holds because nothing under `app/**` yet statically imports `@/db/index` except `auth.ts`'s already-fixed lazy `buildAuthConfig()` path (FND-08 v0.2's Reviewer-bounce fix). `lib/config/quota.ts` and `lib/usage/record.ts` **do** statically import `@/db/index` at module top, but nothing in `app/**` imports either of them yet, so the landmine hasn't gone off. This ticket's new route is the first to need a live `db` handle from inside `app/api/**`, so it inherits this constraint directly and must not reintroduce FND-08's original build break.

Both facts drive the single biggest design decision in this plan (§2.1 below) and are flagged as an ADR candidate, not silently resolved.

---

## 1. Scope

**In scope** (ticket Deliverables 1–4, verbatim):

1. `app/(legal)/privacy/page.tsx`, `app/(legal)/tos/page.tsx` — static, honest legal-content pages, publicly reachable.
2. `app/api/account/delete/route.ts` `POST` — authenticated, single-transaction, cascading hard-delete across every per-user table plus Auth.js's `accounts`/`sessions` plus the `users` row, then sign-out.
3. `app/(app)/settings/page.tsx` + `app/(app)/settings/_components/delete-account-confirm.tsx` — a settings page hosting the delete action behind an explicit confirmation step.
4. `middleware.ts` append — add `/privacy` and `/tos` to `PUBLIC_PATHS`.

**Explicitly out of scope** (ticket Non-goals, plus this plan's own additions found while reading the codebase):

- No data-export ("download my data") feature.
- No `eval_runs` deletion (no `userId` column on that table — confirmed in `db/schema.ts`; it is fixture/regression data, not per-user data).
- No soft-delete/undo window for account deletion; no change to `libraries.deletedAt`'s existing semantics.
- No admin (`PLT-03`), backup (`PLT-02`), or invite-code (`PLT-04`) work — sibling tickets, disjoint files.
- No changes to any `03-library`/`04-fit`/`05-tailor`/`06-prep` route file (none exist yet in this repo — only `app/(app)/home/page.tsx` placeholder and `app/(auth)/signin/page.tsx` exist under `app/(app)/**`/`app/(auth)/**` today).
- No change to `db/index.ts`'s existing `db` export's *behavior* (its neon-http driver, its fail-fast-on-missing-`DATABASE_URL` contract, its "no network call at construction" property) — §2.1 adds a second, independent, purely additive export next to it. `db/index.test.ts`'s existing two assertions must keep passing unmodified.
- No change to `lib/config/quota.ts` / `lib/usage/record.ts` — this ticket does not call either (account deletion is not a quota-checked or usage-billed operation).

## 2. Change list

### 2.1 `db/index.ts` — additive export for transactional delete (ADR candidate — read this first)

**File-scope note:** `db/index.ts` is NOT in this ticket's stated File-scope, and `docs/prd/breakdown-plan.md` §3's global file-ownership table grants no `07-platform-launch` ticket append rights to it (only PLT-04 → `db/schema.ts`, for `invite_codes`). This is a deliberate, documented deviation, justified below — not a silent scope creep. Flag for the Reviewer explicitly.

**Why this is unavoidable.** Deliverable 2(b) requires "within ONE DB transaction." `db/index.ts`'s current `db` export is built on `drizzle-orm/neon-http`, whose `.transaction()` throws unconditionally (verified against the installed package, see plan header). There is no way to satisfy Deliverable 2(b) — or the acceptance checklist's rollback-atomicity test ("mock one of the delete statements to throw... no partial deletion") — using the current `db` export as-is. Three options were considered:

- **(A) Rely on `ON DELETE CASCADE` alone, issue a single `DELETE FROM users WHERE id = ?`.** `db/schema.ts` already sets `onDelete: 'cascade'` on every user-scoped FK (`libraries.userId`, `resumes.userId`, `jobs.userId`, `usageEvents.userId`, `accounts.userId`, `sessions.userId`) and on `tailoredResumes.jobId`/`briefs.jobId` → `jobs.id`. A single statement is *inherently* atomic — no transaction API needed at all, and this ALSO means no `db/index.ts` change. **Rejected**: it contradicts Deliverable 2(b)'s literal enumerated statement list and makes the acceptance checklist's "mock one of the delete statements to throw" test meaningless (there is only one statement). Documented here as a rejected alternative per Feedback obligation #1's instruction to reconcile and record, not silently pick. If a future Reviewer/Horace prefers this simpler design, that is a legitimate ticket-text change, not something this plan pre-empts.
- **(B) Keep `neon-http`, use `db.batch([...])` instead of `db.transaction()`.** `drizzle-orm/neon-http`'s `NeonHttpDatabase` class *does* expose `.batch()` (verified: `neon-http/driver.js:65-66`), which sends all queries as one atomic HTTP transaction server-side. **Rejected**: `.batch()` is neon-http-specific — it does not exist on the generic `PgDatabase`/`drizzle-orm/pglite` instance this repo's entire test suite uses as its local-Postgres substitute (verified: no `batch` method anywhere in `pg-core/db.js` or `pglite/session.js`). Using `.batch()` in production code would mean the route's tests cannot call the same code path at all — the established test-mocking pattern (`vi.doMock('@/db/index', () => ({ db: pgliteDb }))`, used by `lib/config/quota.test.ts`) would need a hand-rolled `.batch()` polyfill that replays already-built query objects against a different session, which is unreliable and would not faithfully test rollback semantics.
- **(C) [Chosen] Append a second, transaction-capable export to `db/index.ts`, using `drizzle-orm/neon-serverless` (`Pool`-based, real interactive `.transaction()`), leaving the existing `db` export completely untouched.** This is the option `db/index.ts`'s own code comment pre-authorizes verbatim: *"if a future ticket (e.g. PLT-01's hard account-delete) needs cross-table atomicity, it may swap this one file to `neon-serverless`; the `db/schema.ts` table objects are driver-independent and would not change."* Verified: `drizzle-orm/neon-serverless`'s session implements real `.transaction()` (`neon-serverless/session.js:178-203`, no throw), and `drizzle-orm/pglite`'s session ALSO implements real `.transaction()` (`pglite/session.js:114-148`, already used throughout this repo's DB tests, e.g. `db/schema-auth.test.ts`'s "cascades: deleting a user removes..." test). So `dbTx.transaction(async (tx) => { ... })` is the **same call, against the same abstract API**, whether `dbTx` is the real neon-serverless Pool (production) or a PGlite instance (tests) — this is exactly the black-box-equivalent test substrate this repo already relies on everywhere else.

  Doing this as an **append** (new export, existing `db` export byte-for-byte unchanged) rather than a swap also resolves the file-ownership tension: `breakdown-plan.md` §3's stated policy for a non-owning module touching another module's file is "append-only: new exports/new tables/new fields, do not restructure existing content" — a new named export is precisely that, unlike replacing `db`'s own driver would have been.

**Concrete change** (illustrative — Builder implements, does not copy verbatim):

```ts
// db/index.ts — existing imports/export unchanged; add:
import { Pool } from '@neondatabase/serverless';
import { drizzle as drizzlePool } from 'drizzle-orm/neon-serverless';
import ws from 'ws';

// ... existing `connectionString` fail-fast check and `export const db = ...` stay as-is ...

// Transaction-capable client, used ONLY where a real multi-statement atomic
// transaction is required (currently: PLT-01's account-delete route). Every
// other call site keeps using `db` above. `ws` is passed explicitly so this
// works identically regardless of the runtime Node.js version's native
// WebSocket support (Node >=22 has one globally; older/edge runtimes may not) —
// removes an environment-dependent unknown rather than relying on it.
export const dbTx = drizzlePool({
  connection: connectionString,
  ws,
  schema,
});
```

`drizzle-orm/neon-serverless`'s `drizzle({ connection, ws, schema })` config form internally does `neonConfig.webSocketConstructor = ws` for you (verified: `neon-serverless/driver.js:66-75`) — no separate `neonConfig` import/call needed.

**`package.json` append (also outside stated File-scope, same justification):** add `ws` as a `dependencies` entry (it is a runtime dependency of `dbTx`, not dev-only). This mirrors FND-08's own precedent of adding `package.json` to its actual touched-files list beyond what its ticket originally stated, recorded as a documented deviation rather than silently done.

**Regression requirement:** `db/index.test.ts`'s existing two tests ("throws... when DATABASE_URL is unset", "constructs the client... no network call... with a dummy URL") must keep passing completely unmodified against `db`. Add two analogous new tests for `dbTx` (same fail-fast-on-missing-URL behavior; same "constructs without throwing / without a network call" behavior for a dummy connection string) — `Pool`/`neon-serverless`'s `Pool` constructor is lazy (no connection attempt until first query, standard `pg`-style Pool semantics), so this should hold, but the Builder must verify it empirically, not assume it.

**Record this deviation** in this ticket's own file (`docs/prd/07-platform-launch/tickets/PLT-01-privacy-tos-account-delete.md`, version bump + note) and in `docs/prd/07-platform-launch/README.md`'s changelog, per this repo's established convention (FND-05/FND-08 both did this for their own build-time deviations). Call out explicitly for the Reviewer: this is a cross-module file touch outside the documented ownership table, justified by a hard technical constraint (§2.1 above) and shaped to be minimally invasive (pure append, zero behavior change to the existing `db` export).

**Related, not-worsened pre-existing risk:** `middleware.ts` (FND-08, unchanged behavior here beyond §2.4's append) already carries an open, untested question — "does `auth()` inside middleware perform a live DB round-trip under `session: 'database'`, and does that work on the Edge runtime `middleware.ts` runs under by default?" — with a commented-out `runtime: 'nodejs'` escape hatch already in place. This plan's `dbTx` addition does not touch that code path (middleware never imports `dbTx`) and does not make that pre-existing question worse: Neon's `neon-serverless` Pool is explicitly designed to be WebSocket-based (Edge-runtime-compatible, unlike a raw TCP `pg` client) for the same reason `neon-http` was originally chosen. Still genuinely unverified without a live `DATABASE_URL` — carried forward, not resolved, same as FND-05/FND-08's own standing infra-provisioning open questions.

### 2.2 `app/api/account/delete/route.ts` (+ `route.test.ts`)

New file. `POST` handler. Key structural requirements, each independently important:

1. **Lazy `db` import — build-time safety.** Do NOT `import { dbTx } from '@/db/index'` at module top level. `next build`'s "Collecting page data" phase statically imports every `app/api/**/route.ts` module (this is exactly the mechanism that broke `pnpm build` for FND-08 v0.1 before its lazy-`buildAuthConfig()` fix — verified again just now by re-running a clean `pnpm build` with zero env vars, which currently succeeds only because no route yet imports `db/index.ts`). Inside the `POST` function body: `const { dbTx } = await import('@/db/index');` — mirrors `auth.ts`'s `buildAuthConfig()` pattern exactly. Getting this wrong reintroduces a `pnpm build` break that would only surface in CI (which sets no `DATABASE_URL`), not necessarily in local dev.
2. **Auth first, outside the transaction.** `const userId = await requireUserId();` from `@/lib/auth/session` — catch `UnauthorizedError` → `NextResponse.json({ error: 'Unauthorized' }, { status: 401 })`, matching the documented pattern in `lib/auth/session.ts`'s own doc comment.
3. **One transaction, explicit ordered deletes** (Deliverable 2(b)'s literal list, FK-safe: children before parents):
   ```ts
   await dbTx.transaction(async (tx) => {
     await tx.delete(usageEvents).where(eq(usageEvents.userId, userId));
     await tx.delete(briefs).where(
       inArray(briefs.jobId, tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.userId, userId))),
     );
     await tx.delete(tailoredResumes).where(
       inArray(tailoredResumes.jobId, tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.userId, userId))),
     );
     await tx.delete(jobs).where(eq(jobs.userId, userId));
     await tx.delete(resumes).where(eq(resumes.userId, userId));
     await tx.delete(libraries).where(eq(libraries.userId, userId));
     await tx.delete(sessions).where(eq(sessions.userId, userId));
     await tx.delete(accounts).where(eq(accounts.userId, userId));
     await tx.delete(users).where(eq(users.id, userId));
   });
   ```
   Do **not** touch `verificationTokens` (no `userId` column — it is keyed by `identifier`/`token` for pending, not-yet-consumed magic-link requests; the ticket names only `accounts`/`sessions`, not this table).
4. **Reconcile with existing `ON DELETE CASCADE` (Feedback obligation #1 — do this explicitly, don't skip it).** `db/schema.ts` already sets `onDelete: 'cascade'` on all eight of these FKs (verified by direct read; also proven behaviorally by `db/schema-auth.test.ts`'s existing cascade test). This means the explicit per-table deletes above and the DB-level cascade triggered by the final `DELETE FROM users` are **not racing** — they run strictly sequentially inside one transaction, so by the time `DELETE FROM users` executes, every child table for this `userId` is already empty and cascade fires as a zero-row no-op. This is intentional defense-in-depth (matches the ticket's literal Deliverable 2 text and makes the rollback-atomicity acceptance test meaningful), not an oversight — **write a code comment saying exactly this**, and record the reconciliation note in the ticket file's changelog per Feedback obligation #1's explicit instruction.
5. **Sign out after successful commit, not before / not on failure.**
   ```ts
   await signOut({ redirect: false });
   return NextResponse.json({ deleted: true });
   ```
   `signOut` is imported from `@/auth` (server-safe, same as `app/layout.tsx`'s existing usage). Verify against the installed `next-auth@5.0.0-beta.31`'s actual behavior (do not assume, per this repo's own established "confirm against the installed version" discipline from FND-08's Feedback obligation #1): does `signOut({ redirect: false })` work correctly when called from inside a Route Handler (not a Server Action)? Does it throw or silently no-op if the underlying `sessions` row is already gone (it will be, since step 3 already deleted it) — this must NOT throw, since the deletion has already successfully committed by this point and a throw here must not be presented to the caller as a failed deletion. Wrap this call in its own try/catch that logs (`console.error`, matching `lib/usage/record.ts`'s established PRD §8.4 "no APM" observability budget) but still returns `{ deleted: true }` on the outer success path — the DB deletion succeeding is what "deleted: true" asserts, not the cookie-clearing side effect.
6. **Transaction failure → don't call signOut, return 500.** Catch the transaction's rejection separately from the `UnauthorizedError` catch; log server-side; return a generic `NextResponse.json({ error: 'Account deletion failed' }, { status: 500 })` — no internal error details in the response body (this is the app's single most destructive endpoint; don't leak schema/query details to a client that just had a failed delete attempt).
7. **Trust boundary:** `userId` comes exclusively from `requireUserId()` (session-derived). The route must accept no `userId` in the request body/query string and must not read one even if present — this is the same discipline `lib/config/quota.ts`'s doc comment already states explicitly for the rest of the app ("no cross-user query path", PRD §8.3).

### 2.3 `app/(app)/settings/page.tsx` + `app/(app)/settings/_components/delete-account-confirm.tsx`

- `settings/page.tsx`: Server Component, already behind `middleware.ts`'s default-protected `app/(app)/**` gate (no code change needed to enforce that — `PUBLIC_PATHS` is a denylist-by-omission allowlist; this new path is protected automatically the moment it exists, same as `app/(app)/home/page.tsx`). Renders `<DeleteAccountConfirm />`. Optionally reads `await auth()` to greet the user by email (nice-to-have, not required by any acceptance item).
- `delete-account-confirm.tsx`: `'use client'`. Ticket explicitly leaves the exact confirmation UX to this ticket's own judgment ("PRD does not specify... this ticket's own reasonable judgment call, documented as such" — Deliverable 3). Recommended pattern, consistent with common practice for an irreversible action: a two-step disclosure — a "Delete my account" button reveals an inline warning plus a text input requiring the user to type a fixed confirmation phrase (e.g. `DELETE`) before the actual destructive submit button is enabled. On submit: `fetch('/api/account/delete', { method: 'POST' })`; on `{ deleted: true }`, navigate away (e.g. `window.location.href = '/'` — a full navigation, not a client-side router push, since the session is now dead and any subsequent client-side fetch would otherwise 401 against stale local state); on error, show an inline error message and leave the account intact.
- No `userId` is read from or passed by this component — the API route derives it from the session (§2.2 point 7).
- No acceptance checklist item tests this component's exact UX mechanics; still write component-level tests (this repo's established "Builder owns the whole test pyramid" convention — see `app/(auth)/signin/page.test.tsx` for the precedent: `@vitest-environment jsdom`, `@testing-library/react`, `afterEach(cleanup)`). At minimum: renders a disabled/gated delete action; typing the confirmation phrase enables it; clicking it calls `fetch('/api/account/delete', ...)` (mock `global.fetch`, do not hit a real route).

### 2.4 `middleware.ts` append

Add `/privacy` and `/tos` to the existing `PUBLIC_PATHS` set (currently `/` and `/signin` — see `middleware.ts:12-15`). This is an append to an existing literal, not a restructure — matches the file's own code comment, which explicitly names this exact future edit and defers ownership to "whichever Architect plans `07-platform-launch`'s tickets" (`docs/plans/FND-08.md` §5 Open Question #3) — that is this plan, resolving that open question now: **yes, PLT-01 is authorized to append here**, per the ticket's own File-scope line 47 ("`middleware.ts` — append `app/(legal)/**`... FND-08 created the file").

```ts
const PUBLIC_PATHS = new Set<string>([
  '/',
  '/signin',
  '/privacy', // app/(legal)/privacy/page.tsx (PLT-01) — must stay reachable while logged out
  '/tos',     // app/(legal)/tos/page.tsx (PLT-01) — must stay reachable while logged out
]);
```

No change to the matcher/config export. Add corresponding assertions to `middleware.test.ts` (root-level, already covers the two existing public paths plus a representative protected path — see `middleware.test.ts:86-96`): `/privacy` and `/tos` pass through unauthenticated with no redirect, same pattern as the existing `/` and `/signin` cases. `middleware.test.ts` is nominally 01-foundation-owned (per `breakdown-plan.md` §3), but this is a minimal, directly-corresponding test append for a change this ticket is independently authorized to make in `middleware.ts` itself — record as a small deviation alongside §2.1's, same discipline (don't silently do it, note it).

### 2.5 `app/(legal)/privacy/page.tsx`, `app/(legal)/tos/page.tsx`

Static Server Components, no props, no data fetching. Content must be true of what this repo *actually* builds (verified against the actually-merged code, not the PRD's aspirational language), per PRD §8.3's own list — each claim traceable to a real, already-implemented mechanism:

- "All data queries are scoped to your account" → `lib/auth/session.ts`'s `requireUserId()` chokepoint + every table's `userId`/`jobs.userId`-join scoping in `db/schema.ts` (verified true).
- "We don't store your original resume file, only the parsed text" → `resumes` table has no blob/file column (`db/schema.ts` comment: "No file/blob columns: originals are discarded after parse"), and the `03-library` module that will populate it doesn't exist yet in this repo but its table shape already enforces this — accurate to state as a system property.
- "Anthropic's API is the only third-party processor of your data" → true of the currently-planned/merged architecture (`ANTHROPIC_API_KEY` in `.env.example`, no analytics SDK anywhere in `package.json`'s dependencies as of this plan).
- "Deleting your account permanently and immediately removes all of your data" → this ticket's own §2.2 delete route, once merged, makes this true; do not publish this claim before that route exists (sequencing: within this same ticket, so fine, but do not let a partial-merge state publish the pages before the route lands, if the Builder ever splits the work across separate commits reviewed independently).
- "We do not integrate third-party analytics; usage is tracked only in our own database for quota and cost-control purposes" → PRD §8.3, confirmed by `lib/usage/record.ts`/`usage_events` and the absence of any analytics dependency in `package.json`.
- ToS: standard-practice sections (acceptable use, no warranty, account termination — including a plain-language pointer to the same hard-delete mechanism) — content depth here is a product/legal-adequacy question, correctly deferred to the ticket's own `[human]` acceptance item (Horace's legal review), not something this plan can or should pre-write.

No machine acceptance item requires specific page copy beyond "reachable while logged out" (§2.4's test) — but do add a minimal render smoke test per page (`app/(legal)/privacy/page.test.tsx`, `app/(legal)/tos/page.test.tsx`) asserting the page renders without throwing and contains a recognizable heading, consistent with this repo's pattern of testing every new page component.

## 3. Test plan

Mapped to the ticket's acceptance checklist:

| Acceptance item | Test location | Technique |
|---|---|---|
| Delete reaches all per-user tables (0 rows after) | `app/api/account/delete/route.test.ts` | PGlite substrate (`@electric-sql/pglite` + `drizzle-orm/pglite`, the established convention — see `db/migrate.test.ts`, `lib/config/quota.test.ts`). `vi.mock('@/auth', () => ({ auth: vi.fn(), signOut: vi.fn() }))` (hoisted, mirrors `lib/auth/session.test.ts`/`middleware.test.ts`'s existing pattern) + `vi.doMock('@/db/index', () => ({ dbTx: pgliteDb }))` + `vi.resetModules()` before a dynamic `await import('@/app/api/account/delete/route')`, mirroring `lib/config/quota.test.ts`'s established `@/db/index` mocking pattern exactly, scoped to the `dbTx` export. Seed one full cross-table row set for one `userId` (reuse `db/migrate.test.ts`'s Tier-3 fixture-construction style — Zod-valid nested jsonb fixtures), call the exported `POST`, then assert zero rows in `usageEvents`/`briefs`/`tailoredResumes`/`jobs`/`resumes`/`libraries`/`accounts`/`sessions`/`users` for that `userId`. |
| `eval_runs` unchanged | same file | Seed one `evalRuns` row unrelated to any user (it has no `userId` column) before calling delete; assert the row count and content are byte-for-byte unchanged after. |
| Rollback atomicity (mid-delete failure) | same file | Seed the full row set for a user; before calling `POST`, wrap the mocked `dbTx`'s `.transaction()` so that inside the callback, one specific `tx.delete(<table>)` call throws (e.g. spy on `tx.delete` and throw when called with the `jobs` table object specifically — table-identity-based injection is more meaningful than a raw call-count index). Assert `POST` returns a 5xx and that **every** table's row count for that user is exactly what it was before the call (nothing partially removed) — this directly exercises `dbTx.transaction()`'s real rollback (PGlite performs a genuine `ROLLBACK`, not a mock). |
| `GET /privacy`/`/tos` reachable unauthenticated | `middleware.test.ts` (append) | Extend the existing `fakeReq(pathname, auth)` pass-through pattern (`middleware.test.ts:73-96`) with `/privacy` and `/tos` cases, `auth: null`, asserting no redirect — identical shape to the existing `/` and `/signin` assertions. |
| `pnpm test` green | full suite | Run after every change. |
| (supplementary, not in the literal checklist but load-bearing for this plan's §2.1 design) `pnpm build` succeeds with zero env vars set | manual verification during build, and worth a CI-level regression note | Confirms the lazy-`dbTx`-import discipline (§2.2 point 1) actually holds — this is exactly the failure mode FND-08 hit and fixed once already; this ticket is the first to re-expose the same class of risk. |

Cross-user isolation: seed a second, distinct `userId` with its own full row set in the same test file and assert its rows are **untouched** after deleting the first user. Note for whoever builds this: the ticket's own Test plan text says to reuse "the isolation-test pattern from `03-library`/LIB-02" — **that ticket/module does not exist yet in this repo** (only `01-foundation` is merged as of this plan; `03-library` has not started). This is a forward reference to a not-yet-built precedent; treat it as pointing at the general idiom (seed two distinct users, assert no cross-contamination — already implicitly present in this repo's per-user-scoped tests, e.g. every `lib/config/quota.test.ts` case uses a fresh `crypto.randomUUID()` per test for isolation) rather than a literal file to copy from. Flagged here so the Builder doesn't spend time searching for a file that isn't there yet.

Settings/confirm component: `app/(app)/settings/_components/delete-account-confirm.tsx`'s own test (jsdom, `@testing-library/react`, mocked `fetch`) — not in the machine acceptance checklist, written anyway per this repo's "own the whole test pyramid" convention (see §2.3).

`vitest.config.ts`'s `test.include` already covers every new file this ticket adds (`app/**/*.test.{ts,tsx}` reaches `app/api/account/delete/route.test.ts`, `app/(app)/settings/_components/delete-account-confirm.test.tsx`, `app/(legal)/**/*.test.tsx`; `*.test.ts` at repo root already reaches `middleware.test.ts`) — no `vitest.config.ts` edit needed, unlike several prior tickets that had to widen it. Verify this assumption by actually confirming the new test files run in `pnpm test`'s output, don't just assume the glob matches.

## 4. Risks & edge cases

**Concurrency (ticket Feedback obligation #2 — explicitly required to be flagged here for the Reviewer):** what happens if a delete request races an in-flight Fit/Tailor/Prep request for the same user (e.g. a Tailor call started just before the user clicks "Delete")? Traced through the schema's actual FK behavior:
- Every downstream write these hypothetical future routes would make (`jobs`, `tailored_resumes`, `briefs`, `usage_events`, `libraries`, `resumes`) carries a `NOT NULL` FK to `users.id` (directly, or via `jobs.id`). Once this ticket's transaction commits and the `users` row is gone, Postgres's FK constraint enforcement will **reject** any concurrent INSERT that references the now-deleted `userId` — the in-flight request gets a DB error (visible to it as a failure), not a silent orphaned row. No data-integrity corruption results; the user experience is "your in-flight action failed" rather than "your data leaked past deletion."
- The transaction-atomicity guarantee (§2.2 point 3/§3's rollback test) covers the delete's own internal consistency; it does not and cannot prevent this race by itself (Postgres `READ COMMITTED`, this repo's default, offers no cross-transaction locking here beyond ordinary FK enforcement).
- **Accepted for this ticket**, per the ticket's own Background: "this ticket's Background does not resolve that race, only the transaction-atomicity of the delete itself." No advisory lock / distributed lock is added. If this is ever judged insufficient, that is a deliberate hardening decision for Horace to weigh (same posture as `lib/config/quota.ts`'s own documented, accepted quota-check race).

**Security-sensitive path (the app's single most destructive endpoint):**
- `requireUserId()` must be the *first* thing the route does, before any DB access — verified structurally in §2.2 point 2; test this explicitly (unauthenticated request → 401, zero DB calls made — assert via a spy that `dbTx.transaction` was never invoked in that case).
- No `userId` may be sourced from the request body/query string (§2.2 point 7) — write a test that POSTs a body containing a different `userId` and asserts the *session's* user, not the body's, is the one deleted.
- The rollback test (§3) is itself a security-relevant test: a partially-completed delete (some tables cleared, others not, with the `users` row still present) would be a strictly worse state than no delete at all — the user would believe their data is gone when it is not (ticket Deliverable 2's own framing).
- `signOut()`'s failure handling (§2.2 point 5) must not be allowed to make a successful DB deletion report itself as failed to the caller, but must also not silently hide a real cookie-clearing problem from server logs.
- Legal pages (`app/(legal)/**`) are public by design (§2.4) — verify they render no session-derived or otherwise user-specific dynamic content (they are Server Components with no data fetching per §2.5, so this should hold structurally, but is worth a one-line assertion in the page's smoke test: no user email/name string appears in the rendered output for an unauthenticated render).

**Build-time DB-free constraint (§2.2 point 1):** the single highest-probability implementation mistake for this ticket is a stray top-level `import { dbTx } from '@/db/index'` (or a top-level import of a `lib/**` helper that itself statically imports `@/db/index`, e.g. accidentally reusing `lib/config/quota.ts`'s pattern without the lazy wrapper) inside `route.ts`. This silently passes local dev (where a developer's shell often has `DATABASE_URL` set) and only fails in CI (which sets none) or on a genuinely clean checkout — exactly the failure mode FND-08 v0.1 shipped and had to bounce-fix. Flag for the Reviewer to specifically check for a static top-level `db`/`dbTx` import in the new route file.

**`db/index.ts` cross-module file-scope deviation (§2.1):** flagged prominently above as an ADR candidate. Restated here for the Risks section's own visibility: this plan chooses to touch a file this ticket's stated File-scope and the global `breakdown-plan.md` §3 ownership table do not grant it, because no alternative satisfies the ticket's literal, explicit Deliverable 2(b) + acceptance-checklist requirements (see the three-option analysis in §2.1). The mitigations applied — pure append (zero behavior change to the pre-existing `db` export), explicit deviation recording in two changelogs, and a Reviewer-facing flag — follow the same pattern this repo already used for FND-08's own out-of-scope `package.json` touch. If the Reviewer or Horace judges this unacceptable, the fallback is option (A) from §2.1 (single-statement cascade-only delete), which is a ticket-text-level simplification, not something this plan can silently substitute.

**Node/WebSocket runtime dependency (§2.1):** `dbTx` depends on a working WebSocket implementation. This repo's CI pins Node 22 (which has a native global `WebSocket`), and the explicit `ws` package dependency (§2.1) removes any ambiguity for other environments (older Node, or whatever Vercel Functions' actual runtime Node version turns out to be — unconfirmed, same standing infra-provisioning unknown as FND-05/FND-08's own `DATABASE_URL`/OAuth open questions). Not expected to be a real problem given the explicit `ws` dependency, but genuinely unverified against a live deployment.

## 5. Open questions

| # | Question | Owner |
|---|---|---|
| 1 | Is the `db/index.ts` append (§2.1, new `dbTx` export via `drizzle-orm/neon-serverless` + `ws`) an acceptable resolution to the neon-http transaction gap, given it touches a file outside this ticket's stated File-scope and outside `breakdown-plan.md` §3's ownership table? This plan recommends yes (pure append, technically necessary, pre-authorized by `db/index.ts`'s own code comment) but flags it as requiring explicit Reviewer sign-off, not a default assumption. | Reviewer stage (`/review-ticket`) first; escalate to Horace if the Reviewer disagrees and no alternative satisfies Deliverable 2(b) as written. |
| 2 | Should `db/index.test.ts`'s new `dbTx`-covering tests (§2.1) be written by this ticket's Builder even though the file is nominally 01-foundation-owned? This plan recommends yes, as a minimal, directly-corresponding regression check for the new export, same append-only spirit as the production-code change it accompanies. | Builder, confirm with Reviewer. |
| 3 | Exact delete-confirmation UX (§2.3 — typed phrase vs. two-click modal vs. something else) — the ticket explicitly leaves this open. This plan's recommendation (typed confirmation phrase) is a suggestion, not a requirement. | Builder's judgment, per ticket Deliverable 3's explicit allowance; no escalation needed unless Horace's later legal/UX review (the ticket's `[human]` item is scoped to legal-page content, not this component, but Horace may comment on both at once) asks for a change. |
| 4 | Privacy Policy / ToS legal adequacy — already an explicit `[human]` acceptance item in the ticket; not resolved by this plan (correctly out of an Architect's/Builder's authority). | Horace. |
| 5 | Real `DATABASE_URL`/Vercel Functions Node runtime version, needed to fully close out the Node/WebSocket risk (§4) and the pre-existing FND-08 Edge-runtime-vs-middleware question this ticket's `dbTx` addition does not worsen but also does not resolve. | Horace (infra), carried forward from FND-05/FND-08's own standing open questions — not new to this ticket. |
