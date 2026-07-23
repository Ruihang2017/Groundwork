# PLT-04 — Implementation Plan

Invite-code gated registration: a Postgres `invite_codes` table, an atomic single-winner redemption helper, an invite-code gate on NEW-account creation only, an invite-code field on the sign-in page, and a CLI script for Horace to mint codes.

Ticket: `docs/prd/07-platform-launch/tickets/PLT-04-invite-codes.md`
Sub-PRD: `docs/prd/07-platform-launch/README.md` (决策 table row 2 — "邀请码存 Postgres 新表 `invite_codes`，不用 env var 静态列表")
Master spec: `docs/PRD.md` §9 ("上线初期以邀请码控制注册节奏"), §8.1, §3 C5, §10 P5
Depends on (merged): FND-05 (`db/schema.ts`, `db/index.ts`, `db/migrations/**`), FND-08 (`auth.ts`, `auth.config.ts`, `middleware.ts`), FND-09 (`app/(auth)/signin/page.tsx` + its documented insertion point), PLT-01 (`app/api/account/delete/route.ts` — see §0 fact 8), PLT-03 (`lib/db/queries/admin.ts` — the lazy-`@/db/index` pattern this plan reuses)
`docs/adr/` is empty. §2.4 flags the one ADR candidate in this ticket; per PLT-03's precedent no ADR file is written by this plan (ticket-planning mode writes exactly one file).

Produced by reading the ticket, the sub-PRD, and the **current merged state** of `auth.ts`, `auth.config.ts`, `auth.test.ts`, `auth.config.test.ts`, `middleware.ts`, `app/(auth)/signin/page.tsx` (+ its test), `app/api/auth/[...nextauth]/route.ts`, `app/api/account/delete/route.ts`, `db/schema.ts`, `db/index.ts`, `db/migrate.test.ts`, `db/schema.test.ts`, `db/schema-auth.test.ts`, `drizzle.config.ts`, `lib/db/queries/admin.ts` (+ its test), `lib/db/queries/library.ts`, `lib/auth/session.ts`, `scripts/eval.mjs`, `.github/scripts/backup.mjs`, `tests/backup.test.ts`, `vitest.config.ts`, `package.json`, `.env.example` — **plus the installed sources** of `@auth/core@0.41.2`, `next-auth@5.0.0-beta.31` and `@auth/drizzle-adapter@1.11.2`, and four executed PGlite probes.

---

## 0. Facts verified at planning time (do not re-derive; do not assume the opposite)

Each was checked against the installed source or an executed probe. **Facts 1–5 invalidate assumptions written into the ticket text.** Do not implement the ticket's literal wording where it contradicts these; implement this plan and record the deviation (§2.9).

1. **The Auth.js `signIn` callback receives NO `isNewUser` signal.** Its parameter object is exactly `{ user, account?, profile?, email?: { verificationRequest?: boolean }, credentials? }` — `node_modules/.pnpm/@auth+core@0.41.2/node_modules/@auth/core/src/index.ts:326-347`. (`isNewUser` exists only on the `events.signIn` *message*, same file line 499, which fires **after** the sign-in is already committed and cannot block it.) The ticket's Deliverable 4 ("receives an `isNewUser`-equivalent signal it can branch on") is **wrong**; we must determine new-vs-existing ourselves (fact 2).

2. **"New user" ⟺ `getUserByEmail(<the sign-in email>)` returns no row**, for both providers this repo configures. Email path: `@auth/core/src/lib/actions/callback/handle-login.ts:92-116` — `getUserByEmail` hit ⇒ `updateUser`, miss ⇒ `createUser` + `isNewUser = true`. OAuth path: same file lines 286-318 — a `getUserByEmail` hit without `allowDangerousEmailAccountLinking` (we do **not** set it) **throws** `OAuthAccountNotLinked`; only a miss reaches `createUser`. So an **exact-match** lookup on `users.email` is an exact reproduction of upstream's own decision. Use `eq(users.email, address)`, **never** a case-insensitive comparison: a case-insensitive "user exists" that upstream would treat as "new" is a silent invite-gate bypass.

3. **The `signIn` callback runs BEFORE the `users` row exists.** OAuth: `handleAuthorized(...)` at `@auth/core/src/lib/actions/callback/index.ts:123-131`, `handleLoginOrRegister(...)` only at line 133. Email: `handleAuthorized` at line 250, `handleLoginOrRegister` at line 254. Email flow *also* invokes the callback earlier still, in `send-token.ts:33-41`, before the magic link is even sent.

4. **`@auth/drizzle-adapter`'s `createUser` DISCARDS the incoming `id`** when the users table's `id` column has a default — `@auth/drizzle-adapter/lib/pg.js:80-87` (`const { id, ...insertData } = data; const hasDefaultId = getTableColumns(usersTable)["id"]["hasDefault"]`). `db/schema.ts:97-100` gives `users.id` a `.$defaultFn(() => crypto.randomUUID())`, so `hasDefault` is **true**. Therefore the `user.id` visible to the `signIn` callback for a new sign-up is a throwaway value (`crypto.randomUUID()` for the email flow, Google's `sub` for OAuth) that will **never** appear in the `users` table.

5. **Probe (executed):** an `UPDATE invite_codes SET used_by = <id not in users> …` is **rejected** — `error: insert or update on table "invite_codes" violates foreign key constraint "invite_codes_used_by_fkey"`. Combined with facts 3+4: `redeemInviteCode(code, <the callback's user.id>)` at gate time would either throw an FK violation or record an id that matches no user. This is the single most important constraint on the design (§2.4 resolves it).

6. **Probe (executed):** with a guarded `UPDATE … WHERE code = $1 AND used_at IS NULL RETURNING code`, `Promise.all([redeem('ABC123','u1'), redeem('ABC123','u2')])` on PGlite returns exactly `[true, false]`, and the row ends up owned by `u1` only. A nonexistent code returns `false` and touches nothing.

7. **Probe (executed):** with `used_by … ON DELETE SET NULL`, deleting the user leaves `{ code: 'ABC123', used_by: null, used_at: 1784… }`. **Consequence: `used_at IS NULL` — never `used_by IS NULL` — is the authoritative "this code is unused" predicate.** Using `used_by` would silently recycle a code the moment its redeemer deleted their account.

8. **PLT-01's account hard-delete ends with `DELETE FROM users` inside one transaction** (`app/api/account/delete/route.ts:81-100`). A new FK from `invite_codes.used_by → users.id` with drizzle's **default** referential action (`NO ACTION`) would make that statement fail for every user who ever redeemed a code — i.e. it would break PRD §5.6's hard-delete privacy control. `onDelete: 'set null'` (§2.1) is load-bearing, not stylistic, and needs **no** edit to PLT-01's route.

9. **The email (Resend) provider invokes the `signIn` callback TWICE; OAuth invokes it once.** Phase 1 = `send-token.ts:33-41`, with `email: { verificationRequest: true }`, *before* the magic link is generated and mailed. Phase 2 = `callback/index.ts:250` when the link is clicked, with **no** `email` key. Phase 2 is unreachable without a valid, unexpired, single-use verification token, which is only created after phase 1 returns truthy (`send-token.ts:41,78-84`) — this is the security argument that lets §2.4 allow phase 2 unconditionally.

10. **Extra options passed to `next-auth/react`'s `signIn()` land in the POST body and are NOT forwarded to the `signIn` callback.** `next-auth/src/react.tsx:288-296` puts `...signInParams` into the request body; `@auth/core`'s `sendToken` reads only `body.email` (`send-token.ts:16-18`) and the OAuth signin action reads only `request.query` (`lib/actions/signin/index.ts:20-27`). The ticket's Deliverable 5 ("passed through to `signIn()`'s options so it reaches the `signIn` callback") **does not work as written**; a cookie is the transport (§2.4/§2.5).

11. **`middleware.ts:4` imports `@/auth`**, so `auth.ts` is part of the Edge middleware bundle. Every request-time-only dependency in `auth.ts` must therefore be behind a **dynamic** `import()` inside a function body — the pattern `auth.ts:36-47` already uses for `@/db/index`. This applies to `next/headers` (§2.4) and `@/lib/db/queries/invite-codes`. Nothing in this repo imports `next/headers` today; `pnpm build` (which runs env-free here) is the verification, and §5 Q1 is the escalation path if it fails.

12. **`pnpm db:generate` needs no `DATABASE_URL`** — `drizzle.config.ts:7-13` documents it and `db/migrate.test.ts:30-62` (Tier 1) already runs `drizzle-kit generate` offline in CI.

13. **PGlite + the real migration chain exceeds Vitest's 5000 ms default under full-suite load (ISS-29).** Every PGlite hook/test passes `30_000` as its **third argument**; `vi.setConfig` inside a hook is a silent no-op. See `lib/db/queries/admin.test.ts:46,52-64`.

14. **`vitest.config.ts:23-38` already covers every test location this ticket needs**: `lib/**/*.test.ts`, `*.test.ts` (repo root), `app/**/*.test.{ts,tsx}`, `tests/**/*.test.ts`. **No `vitest.config.ts` change.**

15. **`events.createUser` fires immediately after the row is created, with the persisted user** (`handle-login.ts:114` email, `:319` OAuth), and `@auth/core` **awaits** it inside the callback route's `try` — so a throw there turns an otherwise-successful sign-in into a `CallbackRouteError` *after* the account already exists. Anything wired into `events.createUser` must be exception-proof (§2.4).

16. **`auth.config.ts` declares no `events` key** (verified, lines 26-64) and exports `signInCallback` as a named function specifically for this ticket to compose (lines 16-24). `auth.config.test.ts:48-51` asserts `authConfig.callbacks.signIn === signInCallback`, i.e. **`auth.config.ts` must stay byte-for-byte unmodified** — composition happens in `auth.ts` (which is this ticket's file-scope).

---

## 1. Scope

**In scope** (ticket Deliverables 1–5):

1. `db/schema.ts` — append the `invite_codes` table (append-only; no existing table touched).
2. `db/migrations/**` — one **generated** migration (`0004_*.sql` + snapshot + journal entry).
3. `lib/db/queries/invite-codes.ts` (+ `lib/db/queries/invite-codes.test.ts`) — normalization, the atomic redemption, post-creation attribution, and the exact-match "does this email already have an account" lookup.
4. `auth.ts` — append: the composed invite-gated `signIn` callback and an `events.createUser` attribution hook, both wired in `buildAuthConfig()`.
5. `app/(auth)/signin/page.tsx` — append at FND-09's `INVITE_CODE_INSERTION_POINT`: an invite-code input whose value is written to a short-lived cookie before either provider's `signIn()` call.
6. `scripts/generate-invite-codes.mjs` — CLI to mint N codes.
7. New test files: `auth-invite.test.ts` (root), `app/(auth)/signin/page-invite.test.tsx`, `tests/generate-invite-codes.test.ts` (§2.7).

**Explicitly out of scope:**

- Everything in the ticket's Non-goals: no self-service/referral invites, no code expiry/TTL, no change to how an **existing** user signs in.
- No `auth.config.ts` change (fact 16). No `middleware.ts` change. No change to any file owned by PLT-01/PLT-03 — in particular **not** `app/api/account/delete/route.ts` (fact 8 makes the edit unnecessary) and **not** `lib/db/queries/admin.ts` (ticket File-scope).
- No admin UI for code generation (ticket Feedback obligation #2 — that is a NEW ticket, §5 Q4).
- No `package.json` script entry and no new dependency: the script is run as `node scripts/generate-invite-codes.mjs --count N` and uses only `node:crypto` plus the already-installed `@neondatabase/serverless`.
- No `vitest.config.ts` change (fact 14). No edits to `db/schema.test.ts`, `db/schema-auth.test.ts`, `db/migrate.test.ts`, `auth.test.ts`, `auth.config.test.ts`, `app/(auth)/signin/page.test.tsx` — all stay byte-for-byte unmodified and act as regression guards.
- No rate limiting on sign-in attempts (§4 R6 argues why the code space makes it unnecessary at v1 scale).
- No custom Auth.js error page telling the user *why* they were rejected (§5 Q2).

---

## 2. Change list

### 2.1 `db/schema.ts` — append one table (append-only)

Append at the end of the file, after the Auth.js tables. Reuse the already-imported `bigint`, `pgTable`, `text`.

```ts
// --- invite_codes ---------------------------------------------------------------
// PLT-04 / PRD §9 "上线初期以邀请码控制注册节奏". The 9th table; nothing above it
// changes. `usedAt` follows this file's convention #1 (bigint epoch-ms), NOT a
// native `timestamp` — the ticket's word "timestamp" is prose, and every non-Auth.js
// timestamp column in this schema is bigint/ms.
//
// TWO LOAD-BEARING DECISIONS, both verified by probe (docs/plans/PLT-04.md §0):
//
// 1. `usedAt IS NULL` — NEVER `usedBy IS NULL` — is the authoritative "unused"
//    predicate. `usedBy` is nulled by the FK when its owner deletes their account
//    (PRD §5.6 hard delete), so a `usedBy`-based guard would silently RECYCLE a
//    spent code. Every query in lib/db/queries/invite-codes.ts guards on usedAt.
// 2. `onDelete: 'set null'` is REQUIRED, not stylistic. PLT-01's account-delete
//    route ends with `DELETE FROM users` inside one transaction; drizzle's default
//    referential action (NO ACTION) would make that statement fail for any user who
//    had redeemed a code — i.e. it would break the PRD §5.6 hard-delete guarantee.
//    'set null' also satisfies §5.6 for this table: after deletion no row here links
//    to the person (a bare epoch-ms `usedAt` identifies nobody).
//
// `usedBy` is nullable for a second, independent reason: the invite gate runs in the
// Auth.js `signIn` callback, which fires BEFORE the users row is created, so the
// redeeming request has no real user id to write. See docs/plans/PLT-04.md §2.4.
export const inviteCodes = pgTable('invite_codes', {
  code: text('code').primaryKey(),
  usedBy: text('used_by').references(() => users.id, { onDelete: 'set null' }),
  usedAt: bigint('used_at', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' })
    .notNull()
    .$defaultFn(() => Date.now()),
});
```

No index beyond the primary key: every query in this ticket looks a row up by `code` (the PK) and the table holds tens of rows.

### 2.2 `db/migrations/**` — generated, never hand-written

Run `pnpm db:generate` (fact 12). Expect a new `0004_*.sql`, a `meta/0004_snapshot.json`, and a `meta/_journal.json` entry. **Do not hand-edit any migration file** (`db/schema.ts:56-58`). Verify by reading the emitted SQL that it contains `CREATE TABLE "invite_codes"` and `ON DELETE set null` on the `used_by` FK — a missing/incorrect referential action is fact 8's regression, and §3.1 asserts it mechanically.

If `drizzle-kit generate` ever pauses for an interactive rename prompt (it should not — this is a brand-new table), stop and report rather than answering blind.

### 2.3 `lib/db/queries/invite-codes.ts` — NEW

Structure copied from `lib/db/queries/admin.ts`: a file header stating the rules, a **memoized** lazy `@/db/index` import (`admin.ts:74-88`, and the reason is spelled out at `lib/db/queries/library.ts:91-127` — vitest's mocker re-resolves a `doMock`-ed specifier on every `import()`, so two same-tick imports race), a local `Executor` type alias, and an additive optional `{ executor?, now? }` options bag on every exported function.

**No top-level `@/db/index` import.** `auth.ts` reaches this module and `auth.ts` is in both the middleware bundle and `next build`'s page-data collection (fact 11).

Exports:

```ts
/** Canonical form: trimmed, upper-cased, and shape-checked. Returns null for anything
 *  that cannot be a code, so no caller ever builds SQL from unvalidated input. Kept
 *  in ONE place: scripts/generate-invite-codes.mjs mints codes in this exact form, so
 *  a stored code is always reachable by a user who typed it in any case/whitespace. */
export function normalizeInviteCode(raw: string | null | undefined): string | null;

/** ATOMIC single-winner redemption (ticket Deliverable 2 + acceptance items 1-3).
 *
 *  ONE statement, no read-then-write:
 *    UPDATE invite_codes SET used_at = $now, used_by = $userId
 *     WHERE code = $code AND used_at IS NULL RETURNING code
 *  → true iff exactly one row came back.
 *
 *  `userId` is WIDENED to `string | null` versus the ticket's literal
 *  `(code: string, userId: string)`. Reason (plan §0 facts 3-5): production calls this
 *  from the signIn callback, which runs BEFORE the users row exists and whose
 *  `user.id` is a value the Drizzle adapter will throw away — writing it would trip
 *  the used_by FK. Passing null claims the code atomically; lib/db/queries/
 *  invite-codes.ts's attachInviteCodeUser() fills in the attribution once the row
 *  exists. Callers that DO hold a real users.id (the tests, any future call site) pass
 *  it and get the ticket's exact one-shot behaviour.
 *
 *  Deliberately does NOT catch an FK violation: passing a userId with no users row is
 *  a programming error and must fail loudly (§3.1 asserts it rejects). */
export async function redeemInviteCode(
  code: string,
  userId: string | null,
  opts?: InviteCodeQueryOptions,
): Promise<boolean>;

/** Best-effort attribution after the users row finally exists.
 *    UPDATE invite_codes SET used_by = $userId
 *     WHERE code = $code AND used_by IS NULL AND used_at IS NOT NULL
 *  Both extra conjuncts matter: `used_at IS NOT NULL` refuses to attribute a code
 *  that was never claimed, `used_by IS NULL` refuses to overwrite someone else's
 *  attribution. Returns false (never throws for a miss) when nothing matched. */
export async function attachInviteCodeUser(
  code: string,
  userId: string,
  opts?: InviteCodeQueryOptions,
): Promise<boolean>;

/** EXACT-match `users.email` existence check — the gate's new-vs-existing test.
 *  Mirrors @auth/core's own getUserByEmail-based determination (plan §0 fact 2).
 *  MUST stay case-SENSITIVE: a case-insensitive hit where upstream would create a
 *  new user is a silent invite-gate bypass. */
export async function isExistingUserEmail(
  email: string,
  opts?: InviteCodeQueryOptions,
): Promise<boolean>;
```

Implementation notes for the Builder:

- `normalizeInviteCode`: `raw.trim().toUpperCase()`, then `/^[A-Z0-9-]{4,64}$/` must match, else `null`. Both `redeemInviteCode` and `attachInviteCodeUser` normalize first and return `false` on `null` — an un-normalizable input is never sent to the database.
- Drizzle form: `db.update(inviteCodes).set({ usedAt: opts?.now ?? Date.now(), usedBy: userId }).where(and(eq(inviteCodes.code, normalized), isNull(inviteCodes.usedAt))).returning({ code: inviteCodes.code })`, then `rows.length === 1`.
- `opts.now` exists for deterministic tests, exactly as `admin.ts:105-117` documents.
- `isExistingUserEmail`: `db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)` → `rows.length === 1`. Never log or return the email.

### 2.4 `auth.ts` — append the gate + the attribution hook (**ADR candidate**)

**ADR candidate (flag, do not bury):** the *transport* — the invite code travels from the sign-in form to the Auth.js `signIn` callback in a short-lived, client-set, non-HttpOnly cookie read via `next/headers` inside the callback — and the *two-phase* claim/attach split it forces. Facts 1, 3, 4, 5 and 10 make this the only mechanism Auth.js v5 leaves open (no request object reaches the callback, and no user id exists at gate time), and reversing it later means touching the sign-in page, `auth.ts` and the schema together. `docs/adr/` is empty; per PLT-03's precedent this plan flags the candidate rather than creating the repo's first ADR for a decision Horace has not reviewed.

Append below the existing `buildAuthConfig`, then wire the two new pieces into its return value. Nothing existing is edited except that return object.

```ts
// One name for the transport, shared with app/(auth)/signin/page.tsx by VALUE not by
// import (that file is 'use client'; keeping the literal in both places is cheaper
// than a shared module and page-invite.test.tsx pins the string on the client side).
export const INVITE_COOKIE_NAME = 'gw_invite_code';

// `next/headers` is imported DYNAMICALLY, inside the function body: middleware.ts
// imports @/auth, so anything static here lands in the Edge middleware bundle
// (plan §0 fact 11). Returns null instead of throwing when there is no request scope
// — the caller then fails CLOSED (a missing code rejects the sign-up).
async function readInviteCodeCookie(): Promise<string | null> {
  try {
    const { cookies } = await import('next/headers');
    return (await cookies()).get(INVITE_COOKIE_NAME)?.value ?? null;
  } catch {
    return null;
  }
}

type SignInCallbackParams = Parameters<
  NonNullable<NonNullable<NextAuthConfig['callbacks']>['signIn']>
>[0];

/**
 * PLT-04 — the invite gate (ticket Deliverable 4). Exported so auth-invite.test.ts
 * can invoke it directly with fabricated @auth/core-shaped params.
 *
 * READ THIS BEFORE CHANGING THE ORDER OF THE BRANCHES.
 */
export async function invitedSignIn(params: SignInCallbackParams): Promise<boolean> {
  // 1. FND-08's base callback still runs first and still wins a `false`.
  if (!(await signInCallback())) return false;

  const { user, account, email: emailFlow } = params;

  // 2. Email provider, PHASE 2 (the magic link was clicked). The gate already ran in
  //    phase 1 (`email.verificationRequest === true`, plan §0 fact 9) and phase 2 is
  //    unreachable without the single-use, hashed, 24h verification token that phase 1
  //    only creates AFTER this callback returned truthy. Re-gating here would instead
  //    break the legitimate cross-device case (link opened on a phone, no cookie) and
  //    would re-check an already-spent code. THIS IS NOT A HOLE — see plan §4 R10.
  if (account?.type === 'email' && emailFlow?.verificationRequest !== true) return true;

  // 3. No email ⇒ we cannot tell new from existing ⇒ fail closed.
  const address = user?.email;
  if (!address) return false;

  // Dynamic import for the same bundle reason as readInviteCodeCookie().
  const { isExistingUserEmail, redeemInviteCode } = await import(
    '@/lib/db/queries/invite-codes'
  );

  // 4. Existing account ⇒ untouched, no code ever requested (ticket Non-goals).
  //    EXACT-match by design (plan §0 fact 2).
  if (await isExistingUserEmail(address)) return true;

  // 5. New account: a valid, unused code is mandatory. `null` for the user id — the
  //    users row does not exist yet and its future id is not knowable here
  //    (plan §0 facts 3-5). This single UPDATE is where the race is decided.
  const code = await readInviteCodeCookie();
  if (!code) return false;
  return await redeemInviteCode(code, null);
}

/**
 * Fills in `invite_codes.used_by` once the users row actually exists (the sub-PRD's
 * "谁用了、何时用" tracking). Fires immediately after createUser for both providers
 * (plan §0 fact 15).
 *
 * MUST NEVER THROW: @auth/core awaits this inside the callback route's try block, so
 * an exception would fail a sign-in whose account has already been created. Attribution
 * is best-effort by design — a magic link opened on another device carries no cookie,
 * in which case `used_at` still records the redemption and `used_by` stays null.
 */
async function attachInviteCodeToNewUser({ user }: { user: { id?: string } }): Promise<void> {
  try {
    const code = await readInviteCodeCookie();
    if (!code || !user?.id) return;
    const { attachInviteCodeUser } = await import('@/lib/db/queries/invite-codes');
    await attachInviteCodeUser(code, user.id);
  } catch (err) {
    // PRD §8.4 "不上 APM" — console.error is the whole error budget. No code, no email.
    console.error('[invite] could not attach invite code to the new user', { err });
  }
}
```

Wire both into `buildAuthConfig()`'s returned object (the only edit to existing lines):

```ts
  return {
    ...authConfig,
    adapter: DrizzleAdapter(db, { /* unchanged */ }),
    // Overrides auth.config.ts's allow-all signIn callback. auth.config.ts itself is
    // NOT edited (auth.config.test.ts:48-51 pins `callbacks.signIn === signInCallback`
    // there) — invitedSignIn composes it instead. Spread first so any future
    // auth.config callback survives.
    callbacks: { ...authConfig.callbacks, signIn: invitedSignIn },
    // auth.config.ts declares no `events` key today (verified); if it ever does, spread
    // it here the same way.
    events: { createUser: attachInviteCodeToNewUser },
  };
```

`signInCallback` must be imported by name from `@/auth.config` (it is already exported there); the default `authConfig` import stays.

### 2.5 `app/(auth)/signin/page.tsx` — append at the documented insertion point

Keep the file `'use client'` and keep `next-auth/react`'s `signIn` (its header comment explains why `@/auth` cannot be imported here). Add module-level constants and one helper, plus `useState` for the field:

```tsx
// Must equal auth.ts's INVITE_COOKIE_NAME. Not imported: auth.ts is server-only.
const INVITE_COOKIE_NAME = 'gw_invite_code';
// 30 minutes: long enough that a magic link clicked on the SAME device still carries
// the code for attribution (auth.ts's events.createUser), short enough that a shared
// machine does not keep it around. The gate itself never needs it after the form POST.
const INVITE_COOKIE_MAX_AGE_SECONDS = 1800;

// The invite code cannot be passed through signIn()'s options — Auth.js does not
// forward request-body fields to the signIn CALLBACK (plan §0 fact 10) — so it travels
// in a cookie the server reads there. Written before EVERY signIn() call, for BOTH
// providers, because either can create a new account.
//
// SECURITY: the value is normalized and shape-checked before it is concatenated into
// document.cookie. Writing raw user input here would let a ';' inject cookie
// attributes (path/domain/expiry). Rejecting silently is correct — the server-side
// gate is what enforces validity, and an unwritable value simply fails closed there.
function rememberInviteCode(raw: string): void {
  const value = raw.trim().toUpperCase();
  if (!/^[A-Z0-9-]{0,64}$/.test(value)) return;
  const secure = window.location.protocol === 'https:' ? '; secure' : '';
  document.cookie =
    `${INVITE_COOKIE_NAME}=${encodeURIComponent(value)}; path=/; ` +
    `max-age=${INVITE_COOKIE_MAX_AGE_SECONDS}; samesite=lax${secure}`;
}
```

- `samesite=lax` (not `strict`): the Google flow returns via a **top-level cross-site GET redirect** from accounts.google.com, which `lax` allows and `strict` would drop — a `strict` cookie silently breaks Google sign-ups for new users.
- Google handler becomes `onClick={() => { rememberInviteCode(inviteCode); signIn('google', { callbackUrl: CALLBACK_URL }); }}`.
- Email handler calls `rememberInviteCode(inviteCode)` before `signIn('resend', { email, inviteCode, callbackUrl: CALLBACK_URL })`. `inviteCode` is passed in the options **only** because the ticket's Deliverable 5 asks for it and it costs nothing (`sendToken` ignores unknown body fields); a comment must state that **the cookie is the load-bearing transport** so no future reader deletes the cookie write believing the option does the work.
- The field itself goes exactly at `INVITE_CODE_INSERTION_POINT` (page.tsx:54-55), replacing that comment with the input and leaving the surrounding form structure alone (FND-09: "append only, do not restructure this form"):

```tsx
<label htmlFor="invite-code">Invite code</label>
<input
  id="invite-code"
  name="inviteCode"
  type="text"
  autoComplete="off"
  value={inviteCode}
  onChange={(e) => setInviteCode(e.target.value)}
  placeholder="Required for new accounts"
/>
<p style={{ fontSize: '0.85rem', margin: 0 }}>
  New accounts need an invite code — it applies to Google sign-in too. Already have an
  account? Leave it blank.
</p>
```

Deliberately **not** `required`: the same field serves returning users (who need no code) and the Google button that sits above the form. The helper text carries what the layout cannot (§5 Q3 asks Horace whether the field should move above the provider buttons in a follow-up).

### 2.6 `scripts/generate-invite-codes.mjs` — NEW (Deliverable 3)

Plain ESM `.mjs`, no TypeScript, run directly (`node scripts/generate-invite-codes.mjs --count 20`). Structured like `.github/scripts/backup.mjs`: **pure, exported functions plus a `main()` guarded by an `import.meta.url === pathToFileURL(process.argv[1]).href` check**, so `tests/generate-invite-codes.test.ts` can exercise the logic without spawning a DB.

```js
#!/usr/bin/env node
import { randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Crockford-ish: no I, L, O, 0 or 1, so a code read aloud or copied off a screen
// cannot be mistyped into a different valid code.
export const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 10;

// randomInt() = node:crypto's CSPRNG, NOT Math.random(). A guessable invite code is a
// direct bypass of the PRD §9 registration-pacing control, so this is a security
// choice, not a style one. 31^10 ≈ 8.2e14 ≈ 2^49.5 possibilities.
export function generateCode() { /* CODE_LENGTH draws from ALPHABET */ }
export function parseCount(argv);   // --count N / --count=N, default 10, integer 1..500
export async function main(argv, env);
```

`main()`:

1. `parseCount` — reject a non-integer, `<1` or `>500` with an actionable message and exit code 1.
2. Fail fast when `env.DATABASE_URL` is unset: print the same kind of pointer `db/index.ts:13-17` gives (`see .env.example`) and exit 1. **Not** PLT-02's silent no-op pattern — that exists because CI runs `backup.mjs` unattended; this is a human-run ops tool where a silent success is a trap.
3. `const { neon } = await import('@neondatabase/serverless'); const sql = neon(env.DATABASE_URL);` — raw SQL, because a `.mjs` cannot import `@/db/schema` (TS + path alias) without the strip-types launcher dance `scripts/eval.mjs` needs. The duplication of table/column names is deliberate and is pinned by a test (§3.4).
4. One statement per code (N ≤ 500; an ops script's round-trips do not matter):
   `` await sql`insert into invite_codes (code, created_at) values (${code}, ${now}) on conflict (code) do nothing returning code` `` — count the returned rows; a collision (astronomically unlikely) is retried once and then reported, never silently printed as if it were newly minted (printing a pre-existing code could hand out somebody else's).
5. Print **one code per line to stdout** and the human summary to **stderr**, so `node scripts/generate-invite-codes.mjs --count 20 > codes.txt` yields a clean distributable list.
6. Exit 0 only if the number of newly inserted codes equals the requested count.

A file-top comment must state that codes are distributed manually by Horace (email/Slack) — outside this system, per the ticket's Non-goals — and that there is no expiry.

### 2.7 File-scope deviations to flag to the Reviewer

The ticket's File-scope lists production files plus `lib/db/queries/invite-codes.test.ts`, but its Test-plan and acceptance items require coverage that has nowhere else to live. Following the precedent this repo already set twice (FND-08 added `db/schema-auth.test.ts` rather than editing FND-05's `db/schema.test.ts`; PLT-02 added `tests/backup.test.ts` and flagged it), this plan authorizes **three new test files** and **zero edits to existing test files**:

| New file | Why it is not in the literal File-scope | Alternative rejected |
|---|---|---|
| `auth-invite.test.ts` (repo root) | acceptance items 4-5 test the `signIn` callback, which lives in `auth.ts` | appending to FND-08's `auth.test.ts` — its file-level `vi.mock('next-auth')` and env juggling would have to be shared with a very different mock set |
| `app/(auth)/signin/page-invite.test.tsx` | Deliverable 5 needs a field/cookie assertion | appending to FND-09's `page.test.tsx` |
| `tests/generate-invite-codes.test.ts` | Deliverable 3 ships executable code; the CSPRNG choice is security-relevant and must be pinned | leaving the script untested |

Record all three in the ticket Changelog as File-scope deviations, exactly as PLT-02 did.

### 2.8 Files explicitly NOT changed

`auth.config.ts` (fact 16) · `middleware.ts` · `db/index.ts` · `app/api/auth/[...nextauth]/route.ts` · `app/api/account/delete/route.ts` (fact 8 — `ON DELETE SET NULL` already satisfies PRD §5.6 for this table, and its `DELETE FROM users` keeps working) · `lib/db/queries/admin.ts` and its test (its `truncate … users … cascade` will now also truncate `invite_codes`; harmless, that suite seeds none) · `lib/db/queries/library.ts` · `db/schema.test.ts` / `db/schema-auth.test.ts` / `db/migrate.test.ts` (its Tier-2 "creates all eight tables" is an existence check over a concatenation, so a 9th table cannot break it) · `vitest.config.ts` · `package.json` · `.env.example` (this ticket introduces no env var).

### 2.9 Writeback (Builder, after the suite is green)

Append a Changelog entry to `docs/prd/07-platform-launch/tickets/PLT-04-invite-codes.md` and a version bump to `docs/prd/07-platform-launch/README.md`, in the shape v0.5 already uses. It **must** name, at minimum: the widened `redeemInviteCode` signature and why (facts 3-5); the cookie transport replacing Deliverable 5's stated mechanism (fact 10); the two-phase claim/attach split; the three new test files (§2.7); the `onDelete: 'set null'` requirement (fact 8); and whether `pnpm build` succeeded with the dynamic `next/headers` import (§5 Q1).

---

## 3. Test plan

Every acceptance item is `[machine]`. Mapping:

### 3.1 `lib/db/queries/invite-codes.test.ts` (PGlite + the real migration chain)

Boot one PGlite per file, `migrate(db, { migrationsFolder: './db/migrations' })`, and `truncate table invite_codes, users restart identity cascade` in `beforeEach` — all with `30_000` as the **third** argument (fact 13). Inject the client through `{ executor }`; import the module **statically**, which is itself the regression guard that it never grew a top-level `@/db/index` import (`admin.test.ts:21-31` explains this exact trick). Use a fixed `now`.

| # | Test | Proves |
|---|---|---|
| 1 | seed unused code + a real user → `redeemInviteCode(code, userId)` returns `true`; row shows `usedBy = userId`, `usedAt = now` | acceptance 1 |
| 2 | nonexistent code → `false`, and `select count(*)` over the table is unchanged | acceptance 2 |
| 3 | already-used code (second call, different user) → `false`, and the row's `usedBy`/`usedAt` are **byte-identical to before the second call** | acceptance 2 |
| 4 | `Promise.all([redeemInviteCode(c,u1), redeemInviteCode(c,u2)])` → exactly one `true`, one `false`; exactly one winner recorded | **acceptance 3 (concurrency)** |
| 5 | `redeemInviteCode(code, null)` → `true`, `usedAt` set, `usedBy` null (the production gate path) | §2.4 step 5 |
| 6 | `redeemInviteCode(code, 'no-such-user')` **rejects** (FK live) | fact 5; stops anyone "fixing" the widened signature back |
| 7 | `attachInviteCodeUser` after a null-claim sets `usedBy`; a second call with another user returns `false` and does not overwrite; attaching to a never-claimed code returns `false` and leaves `usedBy` null | §2.3 |
| 8 | mixed case + surrounding whitespace redeems the same row; a code containing `';'`/`' OR 1=1'`/an empty string returns `false` and touches nothing | normalization + no unvalidated input reaches SQL |
| 9 | `isExistingUserEmail` → `true` for a seeded email, `false` for an unknown one, **and `false` for the same address in different case** | fact 2 (the bypass guard) |
| 10 | redeem with a real user, then `delete from users where id = …` → the delete SUCCEEDS, `usedBy` becomes null, **`usedAt` stays set**, and a further `redeemInviteCode` on that code still returns `false` | fact 7 + fact 8: PLT-01's hard delete keeps working and a spent code is not recycled |
| 11 | the committed migration SQL (read from `db/migrations/*.sql`) contains `CREATE TABLE "invite_codes"` and an `ON DELETE set null` on the `used_by` FK; `getTableName(inviteCodes) === 'invite_codes'` and `getTableColumns` is exactly `['code','usedBy','usedAt','createdAt']` | §2.1/§2.2; keeps FND-05's and FND-08's test files untouched (§2.7) |

**Concurrency test honesty (ticket Feedback obligation #1).** PGlite serializes queries through a single WASM connection, so test 4 proves the **guarded-UPDATE row-count semantics** (the loser's `WHERE used_at IS NULL` no longer matches), not true parallel row-lock contention — precisely the substitution the ticket's acceptance item 3 anticipates. The test must say so in a comment, and the ticket Changelog must carry forward the obligation to re-verify against a real Neon instance under concurrent load before P5 sign-off. Under real Postgres READ COMMITTED the same statement is still single-winner: the second UPDATE blocks on the first's row lock, then re-evaluates its qual against the committed row and matches nothing.

### 3.2 `auth-invite.test.ts` (repo root — acceptance items 4 and 5)

Mock `next-auth` file-level exactly as `auth.test.ts:22-31` does (the real runtime cannot load under Vitest), then per test: `vi.resetModules()`, set a syntactically valid dummy `DATABASE_URL`, `vi.doMock('@/db/index', …)` returning a PGlite-backed drizzle client as both `db` and `dbTx`, `vi.doMock('next/headers', …)` returning a fake cookie store, then `const { buildAuthConfig } = await import('@/auth')` and `const signIn = (await buildAuthConfig()).callbacks!.signIn!`. Restore `DATABASE_URL` in `afterEach` (same shape as `auth.test.ts:33-45`).

| # | Test | Proves |
|---|---|---|
| 1 | NEW email (no `users` row), **no** invite cookie, params `{ user: { email }, account: { type: 'oauth' } }` → `false` | acceptance 4 |
| 2 | NEW email + cookie holding a **nonexistent** code → `false`; same for an **already-used** code | acceptance 4 |
| 3 | NEW email + cookie holding a valid unused code → `true`, **and the row is now claimed** (`usedAt` set, `usedBy` null) | Deliverable 4 |
| 4 | EXISTING `users` row for that email, **no** cookie → `true`; and with a garbage cookie → `true`, and no invite row is modified | **acceptance 5** (Non-goals: existing users unaffected) |
| 5 | email provider **phase 2** (`account.type === 'email'`, no `email.verificationRequest`), NEW email, no cookie → `true` | §2.4 branch 2; a regression here breaks every cross-device magic link |
| 6 | email provider **phase 1** (`email: { verificationRequest: true }`), NEW email, no cookie → `false` | the email flow is gated where it must be |
| 7 | `user.email` absent → `false` | fail-closed |
| 8 | two `invitedSignIn` calls in one `Promise.all` for two different new emails with the SAME cookie code → exactly one `true` | the race is decided at the gate, not just in the query helper |
| 9 | `(await buildAuthConfig()).events?.createUser` is defined; invoking it with a seeded user + a claimed code attaches `usedBy`; invoking it when `next/headers` **throws** resolves without throwing and leaves the row alone | fact 15 (never break a committed sign-in) |
| 10 | importing `@/auth` with `DATABASE_URL` unset still resolves (`auth.test.ts:48-56`'s invariant, re-asserted after this ticket's appends) | build-safety regression |

### 3.3 `app/(auth)/signin/page-invite.test.tsx` (jsdom)

`// @vitest-environment jsdom`, `afterEach(cleanup)`, `vi.mock('next-auth/react', () => ({ signIn: vi.fn() }))` — same preamble as `page.test.tsx:1-20`.

1. An input labelled `/invite code/i` renders.
2. Typing a code then clicking **Continue with Google** writes `gw_invite_code=<UPPERCASED>` into `document.cookie` **before** `signIn('google', …)` is called (assert the cookie inside the `signIn` mock implementation, so the ordering is actually proven).
3. Typing a code then submitting the email form writes the same cookie and calls `signIn('resend', objectContaining({ email, inviteCode, callbackUrl: '/home' }))`.
4. Lower-case/whitespace input is stored upper-cased and trimmed (matches `normalizeInviteCode`).
5. An input containing `;` or `=` (e.g. `abc; domain=evil.com`) writes **no** cookie — the injection guard.
6. Submitting with an empty invite field still calls `signIn` (returning users are not blocked client-side).

### 3.4 `tests/generate-invite-codes.test.ts` (node)

Import the exported helpers from `../scripts/generate-invite-codes.mjs` (PLT-02's `tests/backup.test.ts` imports its `.mjs` the same way).

1. `generateCode()` returns `CODE_LENGTH` chars drawn only from `ALPHABET`, and 500 generated codes are all distinct.
2. `normalizeInviteCode(generateCode())` (imported from the query module) round-trips unchanged — the generator and the redeemer agree on the canonical form. **This is the test that prevents a minted code from being unredeemable.**
3. The script source contains `node:crypto` and does **not** contain `Math.random` — the CSPRNG requirement, pinned mechanically.
4. `parseCount` accepts `--count 20` / `--count=20`, defaults to 10, and rejects `0`, `-1`, `abc`, `1e9`.
5. The script source's INSERT names the table and columns the schema actually has: assert it contains `invite_codes`, `code`, `created_at`, and that these match `getTableName`/`getTableColumns` of `inviteCodes` (guards the deliberate raw-SQL duplication in §2.6).
6. Spawning the script with `DATABASE_URL` unset exits non-zero and prints an actionable message (`spawnSync` with a scrubbed env, as `tests/backup.test.ts` does).

### 3.5 Discovery and the full run (acceptance 6)

All four locations are already covered by `vitest.config.ts:23-38` (fact 14) — but **verify in the run output that all four new files appear**; a silently-undiscovered test file is the false-green failure mode FND-02/05/06/08/09/EVL-01/EVL-02 each hit. Then: `pnpm test` fully green (no pre-existing test edited, so the count must be the current total plus the new ones), `pnpm lint` clean, and `pnpm build` **exit 0 with no env vars set at all** (§5 Q1 — this is the check that clears fact 11's unknown).

---

## 4. Risks & edge cases

**R1 — Concurrency: double redemption (the ticket's P0).** Resolved by one guarded `UPDATE … WHERE used_at IS NULL RETURNING`, never a `SELECT`-then-`UPDATE`. Probe-verified single-winner on PGlite (fact 6); the READ COMMITTED argument for real Postgres is in §3.1. **The one way to reintroduce the race is to "improve" the helper into a read-check plus a write** — the file header must forbid it in those words. Feedback obligation #1 (verify under real concurrent load on Neon before P5) is carried into the ticket Changelog.

**R2 — `next/headers` inside the Edge middleware bundle (build risk).** `middleware.ts` imports `@/auth`, so `auth.ts`'s module graph is compiled for Edge. The dynamic `import('next/headers')` inside a function body is the mitigation; the failure mode, if any, is a **loud build error**, not a runtime surprise. Verification is `pnpm build`; escalation is §5 Q1. Do not "fix" a build failure here by making the import static or by moving the gate into `auth.config.ts` (which would drag the DB into the Edge bundle and break `auth.config.test.ts:31-38`).

**R3 — A code is burned when the magic link is never clicked.** For the email provider the claim happens at phase 1 (fact 9), so a typo'd email address or an unopened invitation consumes the code. Deliberate: it is the only point where the code is guaranteed to be present, and burning a code is recoverable (Horace mints another) while a double-redeem is not. Documented in the code and raised as §5 Q1'.

**R4 — Attribution is best-effort.** `used_by` stays null when the magic link is opened on a device without the cookie (or more than 30 minutes later). `used_at` is always recorded, so the pacing signal — the thing PRD §9 actually asks for — is never lost. Never "fix" this by widening the schema with a `claimed_email` column: that would put an email address in a table PLT-01's hard delete does not sweep, i.e. a PRD §5.6/§12 privacy regression.

**R5 — Account deletion (security-adjacent, cross-ticket).** Covered by `onDelete: 'set null'` + `used_at` as the used-predicate (facts 7, 8), asserted by §3.1 test 10. Two failure modes this prevents: PLT-01's `DELETE FROM users` erroring out (users unable to delete their account), and a spent code silently returning to circulation.

**R6 — Guessable codes (security).** `node:crypto.randomInt` over a 31-char alphabet at length 10 ≈ 2^49.5. No sign-in rate limiting exists in this repo and none is added here; at v1 scale (tens of live codes among 8×10^14 possibilities, each guess costing a full OAuth/magic-link round trip) brute force is not a credible path. **`Math.random()` would collapse this** — pinned by §3.4 test 3. If the alphabet or length is ever shortened, that reasoning must be redone.

**R7 — Cookie injection through `document.cookie`.** User input is normalized, shape-checked and `encodeURIComponent`-ed before concatenation (§2.5); an unmatched value writes nothing. The cookie is client-set and therefore **not** HttpOnly — acceptable because it carries the user's own input and confers nothing: validity is decided server-side against the table. It is deliberately not a bearer token.

**R8 — Normalization drift.** Generator and redeemer must agree on the canonical form or a legitimately-minted code becomes unredeemable. Single normalization point (`normalizeInviteCode`) plus §3.4 test 2 covers it. A code inserted by hand in lower case would be unreachable — the script is the supported path.

**R9 — Is the "existing user" branch a bypass?** No. Claiming an email that already has an account routes into upstream's own logic: the email provider only signs you in after you prove control of that mailbox via the single-use token, and OAuth throws `OAuthAccountNotLinked` (fact 2) rather than creating anything. No account is created on that branch, which is exactly what the gate protects.

**R10 — Is allowing email phase 2 a bypass?** No. Phase 2 requires a verification token that only phase 1 creates, after this gate returned truthy, hashed with `AUTH_SECRET`, single-use and 24h-scoped (fact 9). Gating phase 2 instead would break cross-device links **and** reject the user with an already-spent code.

**R11 — `events.createUser` must never throw** (fact 15) — wrapped in try/catch, asserted by §3.2 test 9.

**R12 — The rejected user sees a generic error.** Returning `false` makes Auth.js redirect to its default error page with `error=AccessDenied`; the user is not told "your invite code is invalid or already used". Known UX gap, out of this ticket's file-scope (a custom error page is FND-09 territory) — §5 Q2.

**R13 — Sign-in attempts leak nothing.** The gate returns a bare boolean; no message distinguishes "no such code" from "already used" from "you need a code", and nothing logs the code or the email.

**R14 — Pre-existing, not introduced here:** middleware runs `auth()` (and therefore `buildAuthConfig`, and therefore the `@/db/index` import) on the Edge runtime — an open FND-08/PLT-03 question. This ticket adds no new work to that path: `invitedSignIn` and `attachInviteCodeToNewUser` are *constructed* there but only *invoked* on `/api/auth/**` requests, which `middleware.ts:90`'s matcher excludes.

---

## 5. Open questions

| # | Question | Who decides |
|---|---|---|
| Q1 | Does `pnpm build` survive the dynamic `next/headers` import inside `auth.ts` (fact 11 / R2)? If it fails on the Edge middleware bundle, the candidate fixes are (a) `export const config = { runtime: 'nodejs' }` in `middleware.ts` — already contemplated at `middleware.ts:91-94` but **outside this ticket's file-scope**, or (b) a different transport, which would change the design. | **Builder verifies; if it fails, STOP and escalate to a human** — do not pick (a) or (b) unilaterally |
| Q1' | Is "the code is burned when the invitation email is sent, even if the link is never clicked" (R3) acceptable operationally? A follow-up could add a `--release <code>` flag to the CLI. | Horace (product) |
| Q2 | Should a rejected new user see *why* (invalid/used code) instead of Auth.js's generic `AccessDenied` page (R12)? That needs a custom error page and touches FND-09's file scope → a new ticket. | Horace (product) |
| Q3 | Should the invite-code field sit **above** the Google button rather than inside the magic-link form? FND-09's insertion point is inside the form and the ticket says append-only, so this plan honours it and compensates with helper text (§2.5). | Horace (product) — a follow-up ticket if he wants the move |
| Q4 | Ticket Feedback obligation #2: if the CLI proves too manual, wiring code generation into `/admin` touches **PLT-03's** file scope and must be a NEW ticket. Log it under 开放问题 in `docs/prd/07-platform-launch/README.md` if raised — never a retroactive edit to PLT-03 or PLT-04. | Horace (product) |
| Q5 | The widened `redeemInviteCode(code, userId: string \| null)` signature and the two-phase claim/attach split are forced by facts 3-5, and the cookie transport is the ADR candidate flagged in §2.4. Should this become `docs/adr/0001-*.md` (the repo's first ADR)? | Horace (architecture) — the Reviewer should confirm the design, not the ADR question |
