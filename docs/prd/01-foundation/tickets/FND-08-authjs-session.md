---
id: FND-08
title: Auth.js v5 (Google OAuth + magic link) and session/userId scoping helper
module: 01-foundation
lane: 01-foundation
size: M
agent: builder
status: draft
date: 2026-07-17
blocked_by: [FND-05]
blocks: [FND-09, LIB-01, LIB-02, FIT-01, PLT-01, PLT-03, PLT-04]
---

# FND-08 — Auth.js v5 (Google OAuth + magic link) and session/userId scoping helper

No ADR — the decision is already made in PRD §8.1 ("Auth.js v5（Google OAuth + email magic link via Resend）… 选 Auth.js 而非 Clerk：无 per-MAU 供应商依赖，Drizzle adapter 成熟，免费") and §8.3 (userId scoping mandate); this is build ticket 8 of 10 against the `01-foundation` module.
Parent sub-PRD: [01-foundation README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [FND-05 — Drizzle schema, Neon Postgres client, and migrations](FND-05-drizzle-schema-neon.md)
**Why `builder`:** wiring a documented library (Auth.js v5) against an already-decided Drizzle schema per PRD-pinned providers, no open design.

## Background + basis

PRD §8.1: "**认证：Cloudflare Access allowlist → Auth.js。** allowlist 只适用于受邀名单，公开注册需要真实 auth。选 Auth.js 而非 Clerk：无 per-MAU 供应商依赖，Drizzle adapter 成熟，免费。" and §8.1's stack line: "Auth.js v5（Google OAuth + email magic link via Resend）".

PRD §8.3 (security): "数据隔离：全部查询以 session userId 约束，无跨用户查询路径。" — this is the mandate for the `requireUserId()` helper this ticket must produce: every API route in every downstream module calls it first, and it must throw/redirect (never silently return an empty/undefined userId) when there is no valid session.

PRD §5.7 doesn't mention a sign-up/sign-in page directly, but PRD §10 P0's exit criteria is explicit: "注册/登录可用，空应用在线" — this ticket (plus FND-09's shell) is what makes that true.

This ticket deliberately leaves an extension point for invite-code gating: `07-platform-launch`/PLT-04 appends an invite-code check into this ticket's `signIn` callback later (per `docs/prd/breakdown-plan.md` §3's append-only file policy) — PRD §9: "上线初期以邀请码控制注册节奏" — but invite codes are NOT part of this ticket's scope (P0 doesn't require them; P5 does).

## Goal

`auth.ts`/`auth.config.ts` (Auth.js v5 configuration: Drizzle adapter bound to FND-05's `users`/`accounts`/`sessions`/`verificationTokens` tables, Google OAuth provider, Resend-based email/magic-link provider), `middleware.ts` (route protection), `lib/auth/session.ts` exporting `requireUserId()`, and the Auth.js route handler under `app/api/auth/[...nextauth]/route.ts` (or the App-Router-idiomatic equivalent Auth.js v5 uses, e.g. `app/api/auth/[...all]/route.ts` per the installed version's docs — Builder confirms the exact path against the installed `next-auth`/`@auth/core` version, since Auth.js v5's exact route convention has shifted across betas; use whatever the installed package's own docs specify, do not guess).

## Non-goals

- No invite-code validation — `07-platform-launch`/PLT-04 (this ticket only leaves the `signIn` callback extensible, e.g. by keeping it a named, exported function PLT-04 can wrap/extend rather than an inline anonymous callback).
- No sign-in page UI — FND-09 (this ticket provides the auth *logic*; FND-09 provides the page that calls Auth.js's client-side `signIn()` function).
- No admin-role concept — `07-platform-launch`/PLT-03 decides its own admin-check mechanism (open question, owner Horace, per `docs/prd/breakdown-plan.md` §6 item 7) and does not require this ticket to add an `isAdmin` column or claim.
- No account deletion — `07-platform-launch`/PLT-01.

## File-scope (write-owns)

- `auth.ts`, `auth.config.ts`, `middleware.ts`, `lib/auth/session.ts`, `app/api/auth/**`
- `db/schema.ts` — append Auth.js's required `accounts`, `sessions`, `verificationTokens` tables (and any adjustments to `users` the Drizzle adapter's type requires) — append-only, FND-05 created the file and this is the documented second touch per `docs/prd/breakdown-plan.md` §3.
- `.env.example` — append `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL` if not already present from FND-01 (verify, do not duplicate — FND-01 already listed these as anticipated keys; this ticket is where they become load-bearing).
- Does not touch: `app/(auth)/signin/page.tsx` (FND-09 creates it; this ticket's route handlers are what that page calls into), `lib/db/queries/**` (feature-module-owned).
- Serial-safety: FND-05 merged before this ticket starts; `db/schema.ts`'s append here is the documented second touch (after FND-05's creation) — no in-flight contention since FND-05 is fully merged first.

## Deliverables

1. `auth.config.ts` exporting the Auth.js v5 `NextAuthConfig` object: `providers: [Google({...}), Resend({...})]` (env-var-sourced credentials, no hardcoded secrets), `adapter: DrizzleAdapter(db, ...)` (importing `db` from FND-05's `db/index.ts` and the newly-added `accounts`/`sessions`/`verificationTokens`/`users` tables from `db/schema.ts`), `session: { strategy: 'database' }` (matches the Drizzle adapter's persisted-session model, not JWT — chosen because the adapter is already database-backed and PRD gives no reason to prefer stateless JWT sessions).
2. `auth.ts` exporting `{ handlers, auth, signIn, signOut } = NextAuth(authConfig)` (Auth.js v5's standard export shape) — `signIn` is exported as a **named, wrapped function** (not consumed directly from the raw `NextAuth()` return in every call site) specifically so `07-platform-launch`/PLT-04 has one clean extension point for the invite-code check, per Background.
3. `app/api/auth/[...route]/route.ts` (exact segment name per the installed Auth.js v5 version's convention) re-exporting `{ GET, POST } = handlers`.
4. `middleware.ts` protecting `app/(app)/**` routes (redirect unauthenticated requests to the sign-in page) — does NOT protect `app/(legal)/**` (public, `07-platform-launch`) or `app/(auth)/**` (must stay reachable while logged out) or the root landing page.
5. `lib/auth/session.ts` exporting `async function requireUserId(): Promise<string>` — calls `auth()`, and if there is no session or no `session.user.id`, throws a typed error (e.g. `UnauthorizedError`) that every API route catches and converts to an HTTP 401 — this is the ONE function every downstream API route in every module imports to get a trustworthy `userId` for query scoping (PRD §8.3's "全部查询以 session userId 约束" mandate, implemented here as a single chokepoint rather than each route re-deriving it from the raw session object, which would risk a route someday forgetting the null-check).

## Acceptance checklist (classified)

- [ ] `[machine]` `requireUserId()` throws `UnauthorizedError` when `auth()` resolves to `null`/no session (unit test with `auth()` mocked to return `null`).
- [ ] `[machine]` `requireUserId()` returns the session's `user.id` string when a valid session is mocked.
- [ ] `[machine]` `middleware.ts`'s matcher config includes `app/(app)/**` paths and excludes `app/(legal)/**`, `app/(auth)/**`, and the root path (unit test on the exported matcher config, or an integration test simulating a request to a protected vs. unprotected path).
- [ ] `[machine]` `db/schema.ts` (after this ticket's append) still passes FND-05's own schema-shape tests unchanged for the original eight tables (regression check — this ticket adds tables, does not modify existing ones).
- [ ] `[machine]` `pnpm test` green.
- [ ] `[human]` Horace registers a real Google OAuth client (client ID/secret) and a Resend account/API key and confirms sign-in end-to-end on a deployed preview — agents cannot self-provision third-party OAuth app registrations or verified sending domains (see Feedback obligation).

## Test plan

Vitest unit tests for `requireUserId()` and the middleware matcher config, mocking Auth.js's `auth()` function (do not make real network calls to Google/Resend in tests). Schema-append regression test reuses FND-05's own test file's assertions, re-run after this ticket's `db/schema.ts` changes, asserting the original eight tables' column sets are byte-for-byte unchanged (guards against an accidental edit while adding the three new tables).

## Feedback obligation

1. Auth.js v5's exact route-handler file convention and `NextAuthConfig` shape may have changed across betas/RCs between when PRD §8.1 was written and whatever version `pnpm add next-auth@5` resolves to at build time — if the installed version's own documentation contradicts a specific mechanical detail in this ticket's Deliverables (e.g. the route segment name, or `session.strategy` defaults), follow the installed version's actual API and record the divergence in this ticket file (version +0.1, changelog line in `01-foundation/README.md`) rather than forcing a stale API shape.
2. Real Google OAuth client registration and Resend account/domain verification require Horace's accounts and cannot be done by an agent — carried forward as open question in `01-foundation/README.md` (same family as FND-01/FND-05's infra hand-offs). Until provisioned, this ticket's own tests must mock `auth()`/providers entirely; no downstream ticket's automated tests may assume real OAuth/email delivery either — flag this explicitly if any later ticket's Test plan implies otherwise.
3. If `session: { strategy: 'database' }` turns out to be materially slower or more complex than JWT for this app's actual usage pattern once real traffic exists, that is a post-P0 performance question for Horace to weigh against PRD §8.4's "不上 APM" simplicity stance — do not silently switch strategies without a decision record.

## Changelog

- v0.1 (2026-07-18, FND-08 Builder writeback): initial implementation. Notable build-time decisions and deviations, recorded here + in `01-foundation/README.md` v0.5:
  - **Version pins (Feedback obligation #1).** Installed `next-auth@5.0.0-beta.31` and `@auth/drizzle-adapter@1.11.2` (both pinned exactly, no floating `@beta` tag). Confirmed compatible: both resolve to the same `@auth/core@0.41.2`. `next-auth@5` resolves through the `beta` prerelease line (the `latest` dist-tag is still v4 `4.24.14`) — pinning the exact version removes that ambiguity.
  - **Route-handler convention CONFIRMED, no change.** `app/api/auth/[...nextauth]/route.ts` re-exporting `{ GET, POST } = handlers` is the installed version's real convention (matches the ticket's Goal exactly) — Feedback obligation #1 checked, no divergence to record beyond this "confirmed" line. `NextAuth()`'s `{ handlers, auth, signIn, signOut }` export shape confirmed unchanged.
  - **`session.user.id` wiring added (detail the ticket did not name).** Under `session: { strategy: 'database' }`, Auth.js's `Session.user` has no `id` by default — a `callbacks.session({ session, user }) { session.user.id = user.id }` callback (plus a `declare module 'next-auth'` `Session.user.id` augmentation in `auth.ts`) is REQUIRED, or `requireUserId()` throws for every real signed-in user despite the mocked unit tests staying green. Implemented and covered by a direct (non-mocked) callback test in `auth.config.test.ts`. This is the single highest-risk item — see plan §4.
  - **`signIn` callback vs. `signIn` action disambiguation (Deliverable 2 vs. Non-goals).** PLT-04's invite-code extension point is implemented as a named, exported `signInCallback` wired into `callbacks.signIn` (the gate that decides whether a sign-in is allowed) — this is what Non-goals describes and where invite-code validation actually belongs in Auth.js. The `signIn` *action* in Deliverable 2 is the client/server action that initiates a flow (`signIn('google')`); it is produced by the standard `NextAuth()` destructure in `auth.ts` and needs no extra wrapping. Both readings end up satisfied.
  - **`package.json` added to file-scope (deviation).** The ticket's File-scope list omitted `package.json`, but Deliverables 1–3 are impossible without adding `next-auth`/`@auth/drizzle-adapter`. Read as an oversight (FND-05's ticket listed `package.json` explicitly for the same reason); `01-foundation` already owns the file, so no cross-module append-only caveat applies. `pnpm-lock.yaml` regenerated as a side effect (not hand-edited).
  - **Second migration generated.** `db/schema.ts`'s three-table append required a new migration (`db/migrations/0001_first_spiral.sql`), generated via `pnpm db:generate` (never hand-authored), per FND-05's established "every schema change → new migration" discipline. drizzle-kit emitted a diff-only migration touching only the three new tables — the eight existing tables' migration/SQL are unchanged (acceptance item 4).
  - **`onDelete: 'cascade'` on `accounts.userId`/`sessions.userId`.** Not in `@auth/drizzle-adapter`'s upstream reference schema (which sets no cascade), added to match FND-05's precedent for the app's other user-scoped tables; behaviorally tested (delete user → account/session rows removed). Flagged for Reviewer (plan §5 Q4).
  - **`vitest.config.ts` `test.include` widened** with `'*.test.ts'` so root-colocated `middleware.test.ts`/`auth.config.test.ts` are discovered (same false-green writeback FND-02/FND-05 made). Verified in the runner output that both root files actually executed.
  - **`.env.example` unchanged** — already lists `AUTH_SECRET`/`AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET`/`RESEND_API_KEY`/`RESEND_FROM_EMAIL` (FND-01); verified, no duplicate added.
  - **Edge-runtime build warning observed (not fatal; carries Feedback obligation #2/#3).** `pnpm build` succeeds (exit 0; `/api/auth/[...nextauth]` + Middleware both compile), but emits Edge-Runtime warnings that `jose`'s `CompressionStream`/`DecompressionStream` (via `@auth/core`'s JWT module, pulled in transitively by `auth.ts`) are unsupported at the Edge. This is the JWE code path, not exercised under the database session strategy this ticket uses, so it is a dead-import warning rather than a runtime failure — the build still produces a working Middleware bundle. The `runtime: 'nodejs'` fallback is left commented in `middleware.ts`. Cannot be fully closed without Horace's live `DATABASE_URL`/OAuth provisioning (the `[human]` acceptance item) — genuinely open, same standing infra hand-off as every FND ticket.
- v0.2 (2026-07-18, FND-08 Builder bounce fix): corrects three Reviewer findings. Supersedes two v0.1 claims (noted inline).
  - **[blocker] Clean-checkout `pnpm build` now genuinely succeeds with NO `DATABASE_URL` (corrects v0.1's "`pnpm build` succeeds (exit 0)", which held only when the Builder's shell had `DATABASE_URL` set).** Root cause: `next build`'s "Collecting page data" imports the auth route → `@/auth` → `@/auth.config` → `@/db/index`, and `db/index.ts` throws at import time when `DATABASE_URL` is unset — a deliberate, FND-05-tested fail-fast (`db/index.test.ts`) that must not be weakened, and which CI (`.github/workflows/ci.yml` sets no `DATABASE_URL`) would trip on the `pnpm build` merge-gate. Fix: the Drizzle adapter (the only `db`-dependent part of the config) moved out of the statically-imported `auth.config.ts` and into Auth.js v5's documented lazy `NextAuth(async () => …)` factory `buildAuthConfig()` in `auth.ts` (confirmed against `next-auth@5.0.0-beta.31`: the factory runs per-request via `await config(req)`, never at module-eval time). `auth.config.ts` is now DB-free; `@/db/schema` is still imported statically (it needs no `DATABASE_URL`). Verified: clean-env `pnpm build` exit 0, `/api/auth/[...nextauth]` + Middleware compile; `db/index.ts` and its import-throw test untouched.
  - **[major] Session-token exposure closed.** v0.1's `callbacks.session` returned the raw `{ ...AdapterSession, user }` object, which under the database strategy carries `sessionToken` (the exact httpOnly session-cookie value) and a top-level `userId`; `@auth/core` sends the callback's return verbatim as the `GET /api/auth/session` body, so any same-origin script could read a durable bearer credential — defeating httpOnly. Now returns only the presentation-safe subset `{ user: { id, name, email, image }, expires }`; the `user.id` wiring (v0.1's highest-risk item) is preserved via `user.id` from the authoritative AdapterUser row. Covered by new filtering assertions in `auth.config.test.ts`.
  - **[minor] Middleware matcher hardened `api` → `api/`** (segment-scoped, not prefix-scoped) so future page routes like `/api-docs`/`/apiary` are no longer silently excluded from auth. Regression-tested in `middleware.test.ts`.
  - **Test-file changes:** new `auth.test.ts` (build DB-independence regression + `buildAuthConfig()` adapter-wiring coverage that used to live on `auth.config`); `auth.config.test.ts` rewritten (adapter assertion relocated to `auth.test.ts`; session-token-filtering guards added). `auth.test.ts` mocks only `next-auth`'s default export to sidestep a Vitest limitation (the real next-auth runtime imports `next/server`, unresolvable under Node ESM in Vitest — the same reason `middleware.test.ts`/`session.test.ts` mock `@/auth`); all DB-relevant code (`@/db/index`, `@/db/schema`, `@auth/drizzle-adapter`, `@/auth.config`, `buildAuthConfig`) runs for real. Full suite: 234 passed (19 files); lint clean.
