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
