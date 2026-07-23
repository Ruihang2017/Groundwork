---
id: PLT-04
title: Invite-code gated registration
module: 07-platform-launch
lane: 07-platform-launch
size: S
agent: builder
status: draft
date: 2026-07-17
blocked_by: [FND-05, FND-08]
blocks: []
---

# PLT-04 — Invite-code gated registration

No ADR — the decision is already made in PRD §9 ("上线初期以邀请码控制注册节奏"); this is build ticket 4 of 4 against the `07-platform-launch` module.
Parent sub-PRD: [07-platform-launch README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [FND-05 — Drizzle schema, Neon Postgres client, and migrations](../../01-foundation/tickets/FND-05-drizzle-schema-neon.md), [FND-08 — Auth.js v5 and session/userId scoping helper](../../01-foundation/tickets/FND-08-authjs-session.md)
**Why `builder`:** extending an already-decided, explicitly-left-extensible `signIn` callback (FND-08) plus a new small table — no open design beyond the storage-mechanism decision already recorded in `07-platform-launch/README.md`.

## Background + basis

PRD §9: "成本结构与漏斗形状一致（P4）：高频的筛最便宜，最贵的 prep 只发生在拿到面邀之后。配额下单用户日成本极限 ≈ $1；**上线初期以邀请码控制注册节奏**，全局日熔断兜底。" — invite codes are the registration-rate control complementing per-user quota (FND-06) and the global spend breaker (also FND-06), forming the three-layer cost-control stack PRD §9/§12 describe.

`01-foundation`/FND-08 deliberately exported `signIn` as "a named, wrapped function (not consumed directly from the raw `NextAuth()` return in every call site) specifically so `07-platform-launch`/PLT-04 has one clean extension point for the invite-code check" — this ticket is that anticipated extension.

PRD gives no schema for invite codes; `07-platform-launch/README.md`'s decision: a Postgres `invite_codes` table (not an env-var static list), because codes need per-code usage tracking (who used it, when) which a static list cannot express — consistent with PRD §8.1's general preference for "无聊技术栈" Postgres-backed mechanisms over ad hoc env-var state (the SAME reasoning FND-06 used for quota counters).

## Goal

`db/schema.ts` append: `invite_codes` table (`code`, `usedBy` nullable FK to `users.id`, `usedAt` nullable, `createdAt`). `auth.ts` append: extend the `signIn` callback to require a valid, unused invite code for NEW user sign-ups (existing users signing back in are unaffected). `app/(auth)/signin/page.tsx` append: an invite-code input field. A small admin-facing way to generate codes (see Deliverable 3).

## Non-goals

- No public self-service invite-code generation (e.g. "invite a friend" referral flow) — PRD's "邀请码控制注册节奏" describes Horace controlling the pace, not users inviting each other; no such feature is named anywhere in §3–§11.
- No invite-code expiry/TTL — PRD names no expiration requirement; codes are valid until used, indefinitely, unless Horace manually removes a row.
- No changes to EXISTING users' sign-in flow — the invite-code check only applies to first-time account creation (Auth.js's `signIn` callback receives an `isNewUser`-equivalent signal it can branch on); a returning user must never be asked for a code again.

## File-scope (write-owns)

- `db/schema.ts` — append `invite_codes` table only (append-only per `docs/prd/breakdown-plan.md` §3; FND-05 created the file, this ticket's addition is a new table, not a modification to any existing one, verified by FND-08's own regression-test convention for schema appends).
- `db/migrations/**` — new migration file for the `invite_codes` table.
- `auth.ts` — append to the existing `signIn` callback (append-only, FND-08 created the file and explicitly designed the extension point for this ticket).
- `app/(auth)/signin/page.tsx` — append an invite-code input field (append-only, FND-09 created the file and left a documented insertion point per that ticket's Deliverable 3).
- `lib/db/queries/invite-codes.ts`, `lib/db/queries/invite-codes.test.ts` (new file, this ticket's own).
- `scripts/generate-invite-codes.mjs` (Deliverable 3, a small CLI script for Horace to generate codes — not a UI, since PRD names no admin UI requirement for this specifically beyond the observability page PLT-03 already covers).
- Does not touch: `lib/db/queries/admin.ts` (PLT-03, a separate concern — invite-code generation is an operational script, not part of the `/admin` observability page).
- Serial-safety: `01-foundation` (all 10 tickets, including FND-05/FND-08's exact append-points already anticipating this ticket) fully merged before this ticket starts. No dependency on/from `03`–`06`; may run in parallel with them.

## Deliverables

1. `db/schema.ts` append: `invite_codes` table — `code` (text, primary key, e.g. a short random string), `usedBy` (nullable FK → `users.id`), `usedAt` (nullable timestamp), `createdAt` (timestamp).
2. `lib/db/queries/invite-codes.ts` exporting `async function redeemInviteCode(code: string, userId: string): Promise<boolean>` — atomically (single UPDATE with a `WHERE usedBy IS NULL` guard, or a transaction) marks the code as used by `userId` IF it exists and is not already used; returns `true`/`false` accordingly. The atomicity matters: two concurrent sign-ups racing to redeem the same code must not both succeed (see Acceptance checklist).
3. `scripts/generate-invite-codes.mjs` — a small Node script Horace runs locally/via `pnpm exec` to insert N new unused codes into `invite_codes` (e.g. `node scripts/generate-invite-codes.mjs --count 20`), printing the generated codes to stdout for Horace to distribute manually (email, Slack, etc. — outside this system, matching PRD's "邀请码控制注册节奏" being an operational/manual pacing lever, not a self-service feature per Non-goals).
4. `auth.ts` append: extend the `signIn` callback — for a sign-in event where the user does not already exist (new account creation), require an `inviteCode` parameter (passed through from the sign-in form) and call `redeemInviteCode`; if it returns `false` (invalid/already-used code), reject the sign-in (Auth.js's `signIn` callback returning `false` blocks the sign-in attempt). Existing users are unaffected (Non-goals).
5. `app/(auth)/signin/page.tsx` append: add an invite-code text input to the existing Google/magic-link sign-in form (per FND-09's documented insertion point), passed through to `signIn()`'s options so it reaches the `signIn` callback.

## Acceptance checklist (classified)

- [ ] `[machine]` `redeemInviteCode` returns `true` and marks the code used for a valid, unused code.
- [ ] `[machine]` `redeemInviteCode` returns `false` for a nonexistent code or an already-used code, without modifying any row.
- [ ] `[machine]` **Concurrency**: two simultaneous `redeemInviteCode` calls for the SAME code (simulated via parallel promises against the local/in-memory Postgres substitute, or a direct assertion on the guarded-UPDATE's row-count semantics if the test substitute doesn't support true concurrency) result in exactly ONE returning `true` — direct proof this repo's `CLAUDE.md` concurrency-focus requirement is met for a genuinely racy operation (unlike FND-06's quota check, which explicitly accepted a documented race — this operation must NOT have the same race, since a double-redeemed invite code directly defeats the registration-pacing control PRD §9 relies on).
- [ ] `[machine]` A sign-in attempt for a NEW user with no/invalid invite code is rejected (mocked `signIn` callback invocation).
- [ ] `[machine]` A sign-in attempt for an EXISTING user (already has a `users` row) succeeds regardless of invite-code presence — direct proof of the Non-goals' "existing users unaffected" rule.
- [ ] `[machine]` `pnpm test` green.

## Test plan

Unit tests for `redeemInviteCode` against the local/in-memory Postgres substitute, including a concurrency test issuing two redemption calls for the same seeded code via `Promise.all` and asserting exactly one `true`/one `false`. Integration tests for the `signIn` callback extension, mocking Auth.js's callback invocation shape for both the new-user and existing-user cases.

## Feedback obligation

1. General rule: the concurrency guarantee in `redeemInviteCode` (Deliverable 2) is the one place in this entire plan where a race condition must be actively PREVENTED (contrast with FND-06's quota check, which explicitly accepts a documented race) — if the chosen atomic-UPDATE approach doesn't actually prevent the double-redemption race once tested against a real (not in-memory-substitute) Postgres instance under real concurrent load, that is a P0-severity gap in a security-adjacent control (registration-pacing bypass) — fix before P5 sign-off, don't ship with a known race here.
2. If Horace finds the CLI-script code-generation flow (Deliverable 3) too manual once actually operating the product, that's a legitimate small follow-up (e.g. wiring code generation into the `/admin` page, PLT-03) — but that would touch PLT-03's file scope, so it must be a NEW ticket, not a retroactive scope-creep edit to either PLT-03 or this ticket; log it as a new item in `07-platform-launch/README.md`'s open questions if raised.

## Changelog

- v0.1 (2026-07-23, PLT-04 Builder writeback): Deliverables 1–5 implemented per `docs/plans/PLT-04.md`. Full suite green (**653 passed, 57 files** — 77 of them new: `lib/db/queries/invite-codes.test.ts` 20, `tests/generate-invite-codes.test.ts` 13, `db/schema-invite-codes.test.ts` 12, `auth.test.ts` +26 (3 → 29), `app/(auth)/signin/page.test.tsx` +6 (3 → 9); every new file confirmed present in the run output, since a test file no glob reaches is this repo's recurring false-green failure mode); `pnpm lint` clean; `next build` with **no environment variables at all** exits 0. Deviations and load-bearing decisions — **all five ticket-text contradictions below were found by the Architect at planning time and are deliberate, not drift**:
  - **(a) `usedBy` is NOT written by `redeemInviteCode` at gate time.** The ticket specifies `redeemInviteCode(code, userId)` writing the `usedBy` FK. Verified against the installed `@auth/core@0.41.2` and `@auth/drizzle-adapter@1.11.2`: `callbacks.signIn` runs **before** the `users` row exists, and the `user.id` it receives is Google's `sub` (or a throwaway UUID for the email provider) which the adapter then **discards** in favour of `users.id`'s own `$defaultFn`. Writing it into the FK would violate the constraint and fail **every** new sign-up. The signature widened to `redeemInviteCode(code, userId: string | null, opts?)` — production passes `null` — and attribution moved to a new `attributeInviteCode(code, userId)` called from a `createUser` **event**, the first moment a real `users.id` exists. `used_by` is therefore advisory only; no logic branches on it.
  - **(b) The single-use guard is `used_at IS NULL`, NOT the ticket's `usedBy IS NULL`.** With the `ON DELETE SET NULL` FK required by (c), a hard account delete nulls `used_by` — so a `used_by` guard hands the code back out and lets **one code mint unlimited accounts via delete-and-re-register**, a direct bypass of the pacing control this ticket exists to build. `used_at` is written once and never cleared. `lib/db/queries/invite-codes.test.ts` proves both halves.
  - **(c) The FK is `onDelete: 'set null'` (the ticket is silent).** The default (`NO ACTION`) would make PLT-01's `DELETE FROM users` **fail** for every user who used a code, silently breaking PRD §5.6's "删号 = 硬删该用户全部数据" as an opaque 500; `'cascade'` would delete the audit row that is the whole reason a table was chosen over an env-var list. A regression test in this ticket's own test file runs the delete and asserts the code stays consumed.
  - **(d) The gate is composed in `auth.ts`, not written into `auth.config.ts`.** The ticket says "extend the `signIn` callback in `auth.ts`"; the callback actually lives in `auth.config.ts` (which FND-08 explicitly left as the extension point). `auth.config.ts` is **byte-for-byte unmodified** — `buildAuthConfig` now takes an optional `Request` and overrides `callbacks.signIn` only on the per-request config object, **wrapping** (not replacing) `signInCallback`, and spreads `...authConfig.callbacks` so FND-08's session-token-stripping `session` callback survives (a regression test pins that identity). `auth.config.test.ts` is untouched and green.
  - **(e) The code travels in a cookie (`gw_invite`), not in `signIn()`'s options.** The ticket's "an `inviteCode` parameter passed through from the sign-in form" is impossible for Google: `@auth/core` calls no server hook before the OAuth redirect, so the gate only runs at `GET /api/auth/callback/google` — a fresh top-level navigation carrying no form body. `NextAuth(factory)` **does** hand the live `Request` to the config factory, making a request-scoped cookie the only channel that works for both providers. The `inviteCode` option is still passed to `signIn('resend', …)` as the ticket asks, and is documented in-code as **read by nothing**. Rejected carriers (each with its failure mode) are in plan §4 R-6. The cookie is client-writable **by design** and is not a security boundary — every security property comes from the atomic server-side redemption.
  - **File-scope extensions (plan §4 R-9), flagged for the Reviewer.** Beyond the ticket's list: `db/schema-invite-codes.test.ts` and `tests/generate-invite-codes.test.ts` (new test files; precedent `db/schema-auth.test.ts` for FND-08's schema append and `tests/backup.test.ts` for PLT-02's `scripts/**` module), plus **test-only appends** to `auth.test.ts` and `app/(auth)/signin/page.test.tsx`. No `vitest.config.ts`, `package.json`, `pnpm-lock.yaml`, `db/index.ts`, `middleware.ts`, `auth.config.ts`, `app/api/account/delete/route.ts` or `lib/db/queries/admin.ts` change was needed, and no new dependency was added.
  - **Consumption timing for magic links is an accepted trade-off** (plan §4 R-2, open question §5 Q2 for Horace): the code is consumed when the email is **requested**, not when the link is **clicked**. A lost/spam-filtered email therefore burns a code (remedy: mint another, or clear that row's `used_at`). The alternative restores retries but denies cross-device link opening and makes `POST /api/auth/signin/resend` a free, ungated email-sending amplifier — a real Resend cost (PRD §9). "One code ⇒ one email ⇒ at most one account" was judged the stronger pacing property. The magic-link **click** is deliberately not re-gated: reaching it requires a verification token only the gated request step could mint.
  - **`[human]` — Feedback obligation #1 is NOT discharged.** The atomicity tests run against PGlite, a **single-connection** WASM Postgres, so `Promise.all`-ed calls are serialised. They prove the guarded-UPDATE predicate (and that the implementation is not a `SELECT`-then-`UPDATE`, asserted structurally as well as behaviourally); they do **not** exercise real row-lock contention. The production guarantee rests on Postgres READ COMMITTED row locking + EvalPlanQual re-evaluation of `WHERE used_at IS NULL`. **One verification against a live Neon instance under genuine parallel load is still owed before P5 sign-off** (blocked on open question #3, real credentials). The test file carries this caveat in-comment so a green run is never reported as the production proof.
  - **No ADR was written** for the cookie-carrier decision. `docs/adr/` is empty and PLT-03 set the precedent of not creating the repo's first ADR for a decision still awaiting confirmation; it is recorded instead as a decision row in `07-platform-launch/README.md`, to be promoted if a second ticket needs the same mechanism or Horace confirms it at P5 (plan §5 Q5).
  - **Also not in scope, by plan:** no custom Auth.js error page (a rejected sign-in lands on the generic `/api/auth/error?error=AccessDenied`; fixing it needs a `pages.error` entry in `auth.config.ts` — a new ticket, §5 Q3), and no rate limiting of code-guessing attempts (~59 bits of `node:crypto` entropy is the control; `Math.random` is forbidden and asserted against, and shortening the code format would make rate limiting mandatory).
  - **Known residual, unfixable without a reservation protocol** (plan §4 R-7): the gate runs before account creation, so a subsequent creation failure (e.g. `OAuthAccountNotLinked`) leaves the code spent. Operationally recoverable by clearing `used_at`; "un-redeeming" in a catch block would reintroduce the race and is explicitly forbidden in-code.
