# PLT-04 — Implementation Plan

Invite-code gated registration: a Postgres `invite_codes` table, an atomic single-use redemption query, an Auth.js `signIn`-callback gate that blocks **new-account creation** without a valid unused code, an invite-code field on the sign-in page, and a CLI script for Horace to mint codes.

Ticket: `docs/prd/07-platform-launch/tickets/PLT-04-invite-codes.md`
Sub-PRD: `docs/prd/07-platform-launch/README.md` (decision table row 2 — "邀请码存 Postgres 新表 `invite_codes`，不用 env var 静态列表")
Master spec: `docs/PRD.md` §9 ("上线初期以邀请码控制注册节奏"), §3 C5, §8.1, §8.3, §10 P5
Depends on (merged): FND-05 (`db/schema.ts`, `db/index.ts`, `db/migrations/**`), FND-08 (`auth.ts`, `auth.config.ts`, `middleware.ts`), FND-09 (`app/(auth)/signin/page.tsx` and its documented insertion point), PLT-01 (`app/api/account/delete/route.ts` — this plan's §4 R-3 interacts with it), PLT-03 (`lib/db/queries/admin.ts` — the lazy-`dbIndex` pattern this plan copies)
`docs/adr/` is **empty**. §2.0 flags the one ADR candidate this ticket contains.

Produced by reading the ticket, the sub-PRD, `docs/prd/breakdown-plan.md` §3, and the **current merged state** of: `auth.ts`, `auth.config.ts`, `auth.test.ts`, `auth.config.test.ts`, `middleware.ts`, `db/schema.ts`, `db/index.ts`, `db/schema.test.ts`, `db/schema-auth.test.ts`, `db/migrate.test.ts`, `db/migrations/**`, `drizzle.config.ts`, `app/(auth)/signin/page.tsx` (+ its test), `app/api/auth/[...nextauth]/route.ts`, `app/api/account/delete/route.ts`, `lib/db/queries/admin.ts` (+ its test), `lib/db/queries/library.ts`, `lib/config/quota.ts`, `scripts/eval.mjs`, `vitest.config.ts`, `package.json`, `tsconfig.json`, `eslint.config.mjs`, `.env.example` — **and** the installed `next-auth@5.0.0-beta.31`, `@auth/core@0.41.2`, `@auth/drizzle-adapter@1.11.2` sources.

---

## 0. Facts verified at planning time — read these before writing any code

Every item below was read directly out of `node_modules` or the repo at planning time. Several of them **contradict the ticket text**; §0.9 resolves each contradiction. Do not re-derive these and do not assume the opposite.

1. **The `signIn` callback lives in `auth.config.ts`, not `auth.ts`.** `auth.config.ts:22-24` exports `signInCallback()` (currently `async () => true`) and wires it at line 39. `auth.ts` only builds the per-request config. `auth.config.ts:16-21` says verbatim: *"PLT-04 (07-platform-launch) wraps or replaces this function"*. The ticket's "auth.ts append" means the auth **config chain**; §2.4 keeps the change in `auth.ts` so `auth.config.ts` is not touched at all.

2. **`NextAuth(factory)` passes the real request to the factory on every `/api/auth/**` call.** `node_modules/next-auth/index.js:102-107`:
   ```js
   if (typeof config === "function") {
     const httpHandler = async (req) => {
       const _config = await config(req);           // <-- req is the live Request
       setEnvDefaults(_config);
       return Auth(reqWithEnvURL(req), _config);
     };
     return { handlers: { GET: httpHandler, POST: httpHandler }, ... };
   ```
   `auth.ts:53` already uses this form (`NextAuth(buildAuthConfig)`), and `app/api/auth/[...nextauth]/route.ts` re-exports those handlers. **This is the ticket's only viable channel for request-scoped data reaching the `signIn` callback** — the callback's own parameters carry no request. `node_modules/next-auth/lib/index.js:39-86` shows the same factory is also called with `undefined` (React Server Components, the `signIn`/`signOut` server actions) and with a `NextRequest` (middleware). **`buildAuthConfig` must therefore accept an optional request and behave correctly when it is `undefined`.**

3. **The `signIn` callback signature has no request, no `isNewUser`, and no way to read the POST body.** `@auth/core` invokes it in exactly two places:
   - `lib/actions/signin/send-token.js:23-27` — the **magic-link request** step (POST `/api/auth/signin/resend`): `callbacks.signIn({ user, account, email: { verificationRequest: true } })`.
   - `lib/actions/callback/index.js:393-409` (`handleAuthorized`) — the **callback** step, called from the OAuth branch (line 63, with `{ user, account, profile }`) and from the email branch (line 167, with `{ user, account }` and **no** `email` key).

   `email?.verificationRequest === true` is the only discriminator between the two email-provider steps. Returning `false` (or throwing) produces `AccessDenied`.

4. **For Google there is no server-side hook before the redirect.** `lib/actions/signin/index.js:8-14`: the oauth/oidc branch only builds the authorization URL — `callbacks.signIn` is **not** called. The gate for Google can only run at `GET /api/auth/callback/google`, a fresh top-level navigation from Google that carries **no** form body. Anything typed into the sign-in form is gone by then unless the browser re-sends it. This is why §2.4 uses a cookie.

5. **`user.id` inside the `signIn` callback is NEVER the eventual `users.id` for a new user — for either provider.**
   - OAuth: `lib/actions/callback/index.js:63-67` passes `userByAccount ?? userFromProvider`; for a first-time signup `userByAccount` is `undefined`, so `user.id` is Google's `sub`.
   - Email: `send-token.js:13-14` and `callback/index.js:156-160` both fall back to `{ id: crypto.randomUUID(), ... }`.
   - And the adapter **discards** whatever id it is handed: `node_modules/.pnpm/@auth+drizzle-adapter@1.11.2/.../lib/pg.js:80-88`:
     ```js
     async createUser(data) {
       const { id, ...insertData } = data;
       const hasDefaultId = getTableColumns(usersTable)["id"]["hasDefault"];
       return client.insert(usersTable).values(hasDefaultId ? insertData : { ...insertData, id })...
     ```
     `db/schema.ts:98-100` gives `users.id` a `.$defaultFn(() => crypto.randomUUID())`, so `hasDefaultId` is **true** and the incoming id is dropped.

   **Consequence (the central design constraint of this ticket): at gate time there is no `users` row and no `users.id`. Writing `user.id` into a column with an FK to `users.id` would violate the FK and fail every new sign-up.** `usedBy` must be filled in later — see §2.4 step 3 and §0.9 (a).

6. **`handleAuthorized` runs BEFORE the user row is created** (`callback/index.js:63` vs `:70`; `:167` vs `:171`). The `createUser` event runs **after** (`handle-login.js:76-78` for email, `:260-263` for oauth) and is where a real `users.id` first exists.

7. **Extra options passed to `next-auth/react`'s `signIn()` are form-encoded into the POST body.** `node_modules/next-auth/react.js:153-164`: `body: new URLSearchParams({ ...signInParams, csrfToken, callbackUrl })`. Useful for the Resend path only (fact 4 kills it for Google), and **unreadable from `buildAuthConfig` without destroying the request** — see §4 R-6.

8. **`auth.config.ts` is loaded into the Edge middleware bundle.** `middleware.ts:4` imports `auth` from `@/auth`, which imports `@/auth.config`. FND-08 already paid for one build break of this class (see `auth.ts:22-35`, `auth.config.ts:5-14`). **Do not add `next/headers`, `@/db/index`, or any Node-only import to `auth.config.ts` or to the static import graph of `auth.ts`.**

9. **Ticket-text contradictions and how this plan resolves them.** Each of these is a deliberate, justified deviation. The Builder must record them in the ticket Changelog and flag them for the Reviewer.

   | # | Ticket says | Reality | Resolution |
   |---|---|---|---|
   | (a) | `usedBy` is a **nullable FK → `users.id`**, set by `redeemInviteCode` at gate time | Fact 5: no `users` row exists at gate time | Keep the nullable FK (**`onDelete: 'set null'`**, see (c)), but fill it in the `createUser` **event**, not at gate time. `redeemInviteCode`'s second parameter widens to `string \| null`. §2.2, §2.4 |
   | (b) | atomic `UPDATE … WHERE usedBy IS NULL` | With `ON DELETE SET NULL` (required by (c)), deleting an account resets `used_by` to NULL and **frees the code for re-use** — a registration-pacing bypass by "delete account, re-register, repeat" | The single-use guard is **`used_at IS NULL`**, never `used_by IS NULL`. `used_at` is set at claim time and is never cleared. §2.2 |
   | (c) | (silent) | PLT-01's hard-delete ends with `DELETE FROM users WHERE id = $1` (`app/api/account/delete/route.ts:100`) and does **not** know about `invite_codes`. A default (`NO ACTION`) FK would make that DELETE **fail** for every user who used a code, silently breaking PRD §5.6's "删号 = 硬删该用户全部数据" | `.references(() => users.id, { onDelete: 'set null' })`. A regression test in **this** ticket's own test file proves the delete still works. §2.2, §3.2 |
   | (d) | "extend the `signIn` callback" in `auth.ts` | The callback is in `auth.config.ts` (fact 1) | Compose it in `auth.ts`'s per-request factory (the only place with the request, fact 2). `auth.config.ts` stays byte-for-byte unmodified, so `auth.config.test.ts` stays green. §2.4 |
   | (e) | "an `inviteCode` parameter (passed through from the sign-in form)" | Facts 4 + 7: form params never reach the Google gate | The form value is carried in a short-lived, client-set, non-httpOnly cookie read from the request in `buildAuthConfig`. §2.0, §2.4, §2.5 |

10. **PGlite is a single-connection WASM Postgres.** Two `Promise.all`-ed queries against one PGlite client are **serialised**; genuine row-lock contention is not reproducible offline. The concurrency acceptance item is still meaningful (§3.2) but its limits must be written down, not glossed — see §4 R-1.

11. **`vitest.config.ts` needs NO change.** `test.include` (lines 23-38) already covers `db/**/*.test.ts`, `lib/**/*.test.ts`, `tests/**/*.test.ts`, `app/**/*.test.{ts,tsx}` and root `*.test.ts` — every new test file in §2 lands under one of those. **Verify this in the run output anyway** (five prior tickets each shipped a test file no glob reached).

12. **PGlite boot + the migration chain exceeds Vitest's 5000 ms default** (ISS-29). Pass `30_000` as the **third argument** of every PGlite-backed `beforeAll`/`beforeEach`/`it` — `vi.setConfig` inside a hook is a silent no-op because a task's timeout is closed over at collection time. Precedent: `lib/db/queries/admin.test.ts:46,52-64`.

13. **`db` (neon-http) cannot run transactions.** `db/index.ts:19-28` + `docs/plans/PLT-01.md` §2.1: `.transaction()` throws unconditionally on neon-http. The redemption must therefore be **one statement**, not a transaction. (It also should be — see §2.2.)

14. **No existing test pins the table count**, so a ninth table breaks nothing. `db/schema.test.ts` enumerates a fixed table map and `db/schema-auth.test.ts` asserts `sqlFileCount >= 2`; both remain green. `drizzle-kit generate` needs no `DATABASE_URL` (`drizzle.config.ts:8-12`).

15. **jsdom does not store `Secure` cookies over `http://`.** Vitest's jsdom origin is `http://localhost:3000`. §2.5's cookie writer must add `Secure` **only** when `location.protocol === 'https:'`, or the page test in §3.4 cannot observe the cookie.

---

## 1. Scope

**In scope:**

1. `db/schema.ts` — **append only**: the `invite_codes` table (§2.2).
2. `db/migrations/0004_*.sql` + `db/migrations/meta/**` — generated by `pnpm db:generate`, never hand-written (§2.3).
3. `lib/db/queries/invite-codes.ts` (new) — `redeemInviteCode`, `attributeInviteCode`, `hasExistingUserWithEmail` (§2.2).
4. `auth.ts` — **append only**: read the invite cookie off the request, compose an invite-aware `signIn` callback around `auth.config.ts`'s `signInCallback`, add a `createUser` event for attribution (§2.4).
5. `app/(auth)/signin/page.tsx` — **append only at the documented `INVITE_CODE_INSERTION_POINT`** (line 54): an optional invite-code input plus the cookie writer, applied to **both** the Google button and the magic-link form (§2.5).
6. `scripts/generate-invite-codes.mjs` (new) — CLI to mint N codes (§2.6).
7. New tests: `db/schema-invite-codes.test.ts`, `lib/db/queries/invite-codes.test.ts`, `tests/generate-invite-codes.test.ts`; appends to `auth.test.ts` and `app/(auth)/signin/page.test.tsx` (§3).

**Explicitly out of scope:**

- Everything in the ticket's Non-goals: **no** self-service / referral code generation, **no** code expiry or TTL, **no** change to an existing user's sign-in path.
- **No** admin UI for code generation (that would touch PLT-03's `app/(admin)/**` and `lib/db/queries/admin.ts` — ticket File-scope forbids it; see §5 Q4 for the escalation path if Horace wants it).
- **No** modification of `auth.config.ts` (§0.9 (d)), `middleware.ts`, `db/index.ts`, `app/api/auth/[...nextauth]/route.ts`, `app/api/account/delete/route.ts`, or any `03`–`06` module file.
- **No** new npm dependency and no `package.json` / `pnpm-lock.yaml` change. (`@neondatabase/serverless` and `drizzle-orm` are already runtime deps; `@electric-sql/pglite` is already a devDependency.) The CLI needs no `db:*` script entry — it is invoked as `node scripts/generate-invite-codes.mjs`.
- **No** `vitest.config.ts` change (§0.11).
- **No** custom Auth.js error page. A rejected sign-in lands on Auth.js's built-in `/api/auth/error?error=AccessDenied`; improving that requires a `pages.error` entry in `auth.config.ts`, which is out of scope — §5 Q3.
- **No** rate-limiting of code-guessing attempts (§4 R-5 explains why the code's entropy carries this instead, and what would change that).

---

## 2. Change list

### 2.0 The one hard-to-reverse choice — **ADR candidate, flagged not buried**

> **Decision:** the invite code travels from the sign-in form to the server in a **client-set, non-httpOnly, `SameSite=Lax` cookie (`gw_invite`)**, read out of the request inside `auth.ts`'s per-request `NextAuth(async (req) => …)` config factory, and consumed by a `signIn` callback closed over that value.

This is the plan's only architecturally load-bearing decision, and it is forced rather than chosen: facts §0.3 + §0.4 show the `signIn` callback receives no request and Google's flow offers no pre-redirect server hook, so a request-scoped side channel is the *only* way an invite code can reach the gate for the Google provider. Rejected alternatives, with the reason each fails, are in §4 R-6.

It is reversible in code (the cookie read is ~15 lines in `auth.ts` plus ~10 in the page) but it establishes a **precedent for smuggling request state into Auth.js callbacks** that later tickets will copy. Per PLT-03's precedent (`docs/plans/PLT-03.md` §2.1) and because `docs/adr/` is currently empty: **do not create an ADR inside this ticket.** Record it as a decision row in `docs/prd/07-platform-launch/README.md` during Builder writeback, and promote it to `docs/adr/0001-*.md` only if a second ticket needs the same mechanism or Horace confirms it at P5.

### 2.1 Module layout at a glance

| File | Kind | Contents |
|---|---|---|
| `db/schema.ts` | append | `inviteCodes` table |
| `lib/db/queries/invite-codes.ts` | new | `redeemInviteCode`, `attributeInviteCode`, `hasExistingUserWithEmail`, `Executor` type |
| `auth.ts` | append | `readInviteCodeCookie`, `createInviteGate`, wiring into `buildAuthConfig(req)` |
| `app/(auth)/signin/page.tsx` | append | invite input + `writeInviteCookie` |
| `scripts/generate-invite-codes.mjs` | new | `makeCode`, `parseCount` (exported, pure) + a `main()` guarded by an is-main check |

### 2.2 `db/schema.ts` (append) and `lib/db/queries/invite-codes.ts` (new)

**Table** — appended at the end of `db/schema.ts`, after `verificationTokens`, following the file's own convention block (lines 33-59):

```ts
// --- invite_codes (PLT-04) ----------------------------------------------------
export const inviteCodes = pgTable('invite_codes', {
  code: text('code').primaryKey(),
  usedBy: text('used_by').references(() => users.id, { onDelete: 'set null' }),
  usedAt: bigint('used_at', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' })
    .notNull()
    .$defaultFn(() => Date.now()),
});
```

Rules the code comment above it must state, because each is load-bearing and non-obvious:

1. **`used_at` — not `used_by` — is the single-use guard.** §0.9 (b): `ON DELETE SET NULL` nulls `used_by` when an account is hard-deleted, so a `used_by IS NULL` guard would hand the code back out and let one code mint unlimited accounts via delete-and-re-register. `used_at` is written once and never cleared.
2. **`onDelete: 'set null'` is mandatory, not stylistic.** §0.9 (c): the default FK action would make PLT-01's `DELETE FROM users` fail. `'cascade'` is also wrong — it would delete the whole row, destroying the "when was this code consumed" record that is the entire reason the sub-PRD chose a table over an env-var list.
3. **`used_by` is advisory attribution, never a control.** It is populated best-effort by the `createUser` event (§2.4 step 3) and may legitimately stay `NULL` — for a magic link opened in a browser that no longer has the cookie, and permanently after that user deletes their account. No logic may branch on it.
4. **No extra index.** Every lookup is by `code`, which is the primary key.
5. `used_at` / `created_at` are `bigint` epoch-ms per the file's convention #1. **No email or other PII column** — see §4 R-3.

**Query module** — `lib/db/queries/invite-codes.ts`. Copy the structural conventions of `lib/db/queries/admin.ts:41-117` verbatim:

- **No top-level `import { db } from '@/db/index'`.** Use the memoised lazy `dbIndexPromise` / `dbIndex()` / `defaultDb()` trio (`admin.ts:74-88`). This module is imported by `auth.ts`, which `next build` pulls into the static graph for both the auth route and `middleware.ts`; a static `@/db/index` import re-breaks the clean-checkout build that FND-08 already bounced on once (fact §0.8). The memo is required for testability, not performance — `admin.ts:64-73` and `library.ts:91-118` record why.
- A locally-declared `export type Executor = PgDatabase<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>` and an optional `{ executor?: Executor }` options bag on every function, so tests inject PGlite (`admin.ts:99-116` precedent).
- **`db` (neon-http) only. Never `dbTx`, never `.transaction()`** (fact §0.13).

```ts
export async function redeemInviteCode(
  code: string,
  userId: string | null,          // widened per §0.9 (a); a plain string still type-checks
  opts?: { executor?: Executor; now?: number },
): Promise<boolean>
```

Body — **exactly one statement**, a guarded UPDATE with `.returning()`:

```ts
const rows = await db
  .update(inviteCodes)
  .set({ usedBy: userId, usedAt: opts?.now ?? Date.now() })
  .where(and(eq(inviteCodes.code, code), isNull(inviteCodes.usedAt)))
  .returning({ code: inviteCodes.code });
return rows.length === 1;
```

Why this shape and not a read-then-write or a transaction:

- Postgres evaluates `UPDATE … WHERE` under READ COMMITTED by taking a row lock and then **re-checking the predicate against the updated row** (EvalPlanQual). Two concurrent redemptions of the same code therefore produce exactly one updated row; the loser matches zero rows and returns `false`. A `SELECT` followed by an `UPDATE` has a genuine TOCTOU window and **must not** be used. This is the one place in this ticket where a race must be actively prevented (ticket Feedback obligation #1) — the contrast is `lib/config/quota.ts`, which documents and accepts its check/record race.
- No transaction is needed, and none is possible on `db` (fact §0.13).
- A nonexistent code and an already-used code both return `false` with zero rows written — the same code path, no branching, so acceptance item 2's "without modifying any row" is structural.
- `now` is injectable so the timestamp assertion in §3.2 is exact instead of racing the wall clock (`admin.ts:105-117` precedent).

```ts
export async function attributeInviteCode(
  code: string,
  userId: string,
  opts?: { executor?: Executor },
): Promise<void>
```

`UPDATE invite_codes SET used_by = $userId WHERE code = $code AND used_by IS NULL AND used_at IS NOT NULL`. The `used_at IS NOT NULL` conjunct means it can only ever annotate a code that was actually claimed; it can never claim one. Returns `void` — the caller must not branch on the outcome (rule 3 above).

```ts
export async function hasExistingUserWithEmail(
  email: string | null | undefined,
  opts?: { executor?: Executor },
): Promise<boolean>
```

`SELECT 1 FROM users WHERE email = $1 LIMIT 1`. Document three things in the comment:

- **Why it lives in this file** rather than a new `lib/db/queries/users.ts`: it exists solely as the invite gate's new-vs-existing discriminator (fact §0.5 removed every other reliable signal), and a new general-purpose users-query module is outside the ticket's file scope. It is not a general user lookup and must not grow into one.
- **Exact match, deliberately.** `@auth/drizzle-adapter`'s `getUserByEmail` is an exact `eq`, and `handleLoginOrRegister` (`handle-login.js:57`, `:231-233`) uses that to decide whether to create a user. Matching case-insensitively here would make the gate and the adapter disagree about who is new. `@auth/core`'s email provider already lower-cases and trims before it reaches us (`send-token.js:74-98`).
- **Fail closed:** `null`/`undefined`/empty email returns `false` (⇒ treated as a new user ⇒ invite code required).

### 2.3 Migration

Run `pnpm db:generate` (needs no `DATABASE_URL`). Commit the emitted `db/migrations/0004_*.sql`, its `meta/0004_snapshot.json`, and the updated `meta/_journal.json`. **Never hand-edit** an existing migration (`db/schema.ts` convention #4). Confirm the generated SQL contains `CREATE TABLE "invite_codes"` and `ON DELETE set null` on the `used_by` FK, and touches no other table.

### 2.4 `auth.ts` (append) — the gate

Everything here is added to `auth.ts`. `auth.config.ts` is not touched (§0.9 (d)), which keeps `auth.config.test.ts:41-52` green — it asserts the *static* config's `callbacks.signIn === signInCallback`, and this ticket overrides `callbacks.signIn` only on the per-request config object returned by `buildAuthConfig`.

**Step 1 — read the cookie (exported for direct unit testing).**

```ts
export const INVITE_COOKIE_NAME = 'gw_invite';
export function readInviteCodeCookie(req?: Request): string | undefined
```

Parse `req?.headers.get('cookie')` **by hand** — split on `;`, trim, split each pair at the **first** `=` only (a base32 code contains no `=`, but a co-resident cookie may), match the name exactly, `decodeURIComponent` inside a `try/catch` (a malformed `%zz` throws). Then normalise: trim, return `undefined` for empty, and reject anything longer than 64 characters or containing a character outside `[A-Za-z0-9-]` **before** it can reach the database. Do **not** use `next/headers` (fact §0.8) and do **not** use `NextRequest.cookies` — plain `Request.headers` is what both the route-handler and middleware call sites supply, and it makes the unit test a one-liner.

**Step 2 — compose the callback (exported, dependency-injected).**

```ts
export function createInviteGate(
  inviteCode: string | undefined,
  deps?: {
    hasExistingUserWithEmail?: typeof hasExistingUserWithEmail;
    redeemInviteCode?: typeof redeemInviteCode;
    attributeInviteCode?: typeof attributeInviteCode;
  },
): { signIn: NonNullable<NextAuthConfig['callbacks']>['signIn']; createUser: (p: { user: { id: string } }) => Promise<void> }
```

The `deps` bag defaults to the real query functions and exists so `auth.test.ts` can drive acceptance items 4 and 5 with plain fakes — no PGlite, no module mocking, no DB. Decision logic, in this exact order:

```
signIn({ user, account, email }):
  1. if (await hasExistingUserWithEmail(user?.email)) return true;
        // Non-goal 3: a returning user is NEVER asked for a code, for any provider,
        // regardless of whether a cookie is present.
  2. if (account?.type === 'email' && email?.verificationRequest !== true) return true;
        // The magic-link CLICK (fact §0.3, callback/index.js:167). Step 4 below already
        // consumed a code to get this email sent, and reaching here requires a valid
        // verification token that only that gated step could create. Re-gating here
        // would deny every user who opens the link on a different device, where the
        // cookie does not exist.
  3. if (!inviteCode) return false;
  4. return await redeemInviteCode(inviteCode, null);
        // null: there is no users.id yet (fact §0.5). Attribution happens in createUser.

createUser({ user }):
  if (!inviteCode) return;
  try { await attributeInviteCode(inviteCode, user.id); }
  catch (err) { console.error('[invite] attribution failed', err); }   // never rethrow
```

- **Order matters.** The existing-user check runs first so an existing user is never charged a code and never denied — acceptance item 5.
- **Step 4 is the only consumption point per sign-in attempt.** Google consumes at `GET /api/auth/callback/google`; Resend consumes at `POST /api/auth/signin/resend` (which also stops the endpoint being a free, ungated email-sending amplifier — a real Resend cost, PRD §9). §4 R-2 records the accepted UX cost and the alternative that trades it for a different one.
- **`createUser` must never throw.** `callback/index.js:385-391` wraps the whole branch: a throw there becomes `CallbackRouteError` and fails a sign-in whose account row already exists. Attribution is advisory (§2.2 rule 3).
- **A thrown `redeemInviteCode` (DB down) fails closed** — `handleAuthorized` converts it to `AccessDenied` (`callback/index.js:399-402`). Correct for a gate; note it in the comment so nobody "helpfully" adds a `catch → true`.

**Step 3 — wire it into the factory.**

```ts
export async function buildAuthConfig(req?: Request): Promise<NextAuthConfig> {
  const { db } = await import('@/db/index');
  const gate = createInviteGate(readInviteCodeCookie(req));
  return {
    ...authConfig,
    adapter: DrizzleAdapter(db, { /* unchanged */ }),
    callbacks: {
      ...authConfig.callbacks,
      signIn: async (params) => (await signInCallback()) && (await gate.signIn(params)),
    },
    events: { ...authConfig.events, createUser: gate.createUser },
  };
}
```

- Adding the optional `req` parameter is source-compatible with `NextAuth(buildAuthConfig)` and with `auth.test.ts:78`'s existing zero-argument `buildAuthConfig()` call.
- `signInCallback()` is still called first, honouring `auth.config.ts:16-21`'s "wraps **or** replaces" instruction with the non-destructive option, so a future FND-08-side change to the base callback keeps taking effect.
- `...authConfig.callbacks` preserves the `session` callback — dropping it would re-open FND-08 Reviewer finding #2 (session-token leakage). **Spread it; do not retype it.**
- **Do NOT read `req.body`, `req.text()`, or `req.formData()` here.** The body is a single-use stream and `@auth/core` needs it; consuming it makes `sendToken` see `email === undefined` and throw (§4 R-6).

### 2.5 `app/(auth)/signin/page.tsx` (append)

Insert **only** at the `INVITE_CODE_INSERTION_POINT` marker (line 54) plus the small additions the marker implies; do not restructure the form.

1. `const [inviteCode, setInviteCode] = useState('')`.
2. A module-scope helper:
   ```ts
   function writeInviteCookie(code: string) {
     const trimmed = code.trim();
     const secure = window.location.protocol === 'https:' ? '; Secure' : '';
     document.cookie = trimmed
       ? `gw_invite=${encodeURIComponent(trimmed)}; Path=/; Max-Age=86400; SameSite=Lax${secure}`
       : `gw_invite=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
   }
   ```
   - **`SameSite=Lax`, never `Strict`.** The Google callback is a cross-site-initiated top-level GET navigation; `Strict` would withhold the cookie and break Google sign-up entirely.
   - **`Secure` only on https** — fact §0.15, otherwise the jsdom test cannot see it.
   - **`Max-Age=86400`** matches `@auth/core`'s 24 h verification-token lifetime (`send-token.js:44-45`), so attribution still works when a magic link is opened hours later in the same browser.
   - **The empty branch (delete) is mandatory, not defensive tidiness.** It is what makes the long `Max-Age` safe: because *every* sign-in attempt starts on this page and this helper runs on every attempt, a leftover code can never be silently consumed by a different new user on a shared browser.
3. Call `writeInviteCookie(inviteCode)` **immediately before** `signIn(...)` in **both** the Google `onClick` and the form `onSubmit`. Google sign-up is gated too (fact §0.4); wiring the field only into the magic-link form would let anyone create an account through Google.
4. The input itself: `id="inviteCode"`, a `<label htmlFor="inviteCode">`, and **`required` must NOT be set** — a returning user signing in by magic link must be able to submit with it empty (Non-goal 3). Label it so that is obvious, e.g. `Invite code (new accounts only)`.
5. Keep passing `inviteCode` in the Resend `signIn('resend', { email, inviteCode, callbackUrl })` options as well. It is harmless (fact §0.7 form-encodes it into the POST body), it is what the ticket's Deliverable 5 literally asks for, and it documents intent — but **nothing reads it**; the cookie is the only channel. Say so in the comment so a later reader does not "fix" the gate to depend on it.
6. Do **not** disable the Google button when the field is empty (that would lock out returning Google users).

### 2.6 `scripts/generate-invite-codes.mjs` (new)

Plain ESM `.mjs`, no TypeScript, no build step, invoked as `node scripts/generate-invite-codes.mjs --count 20`. Follow `.github/scripts/backup.mjs`'s guard style and `scripts/eval.mjs`'s exit-code style; **no `package.json` script entry** (it is an occasional operator tool, not part of the dev loop).

- **Export the pure parts** — `export function parseCount(argv)` and `export function makeCode()` — and run the DB work only from a `main()` behind an is-main guard (`import.meta.url === pathToFileURL(process.argv[1]).href`). This is what makes §3.5 a real unit test rather than a subprocess smoke test.
- `makeCode()`: **`randomInt` from `node:crypto`** over a 32-character ambiguity-free alphabet (`ABCDEFGHJKMNPQRSTVWXYZ23456789` style — no `0`/`O`, `1`/`I`/`l`), length 12 ⇒ ~60 bits. **`Math.random()` is forbidden** — this string is the sole registration credential (§4 R-5). Emit it in a fixed shape (e.g. `XXXX-XXXX-XXXX`) only if the hyphen is inside the accepted charset of §2.4 step 1; the `[A-Za-z0-9-]` filter there allows it.
- `parseCount(argv)`: default 10, must be a positive integer, hard cap 1000, exit 1 with an actionable message otherwise.
- DB access **without** the `@/` alias (a `.mjs` cannot use tsconfig paths): `import { neon } from '@neondatabase/serverless'` and issue parameterised SQL through its tagged template. Do not import `@/db/index` or `drizzle-orm`.
- Missing `DATABASE_URL` ⇒ exit 1 with the same actionable wording as `db/index.ts:13-17`. Never print a connection string.
- Insert with `ON CONFLICT (code) DO NOTHING RETURNING code` and print **only the codes actually inserted**, one per line, plus a count summary on stderr. Exit non-zero if fewer than requested were inserted, so a silent shortfall cannot be mistaken for success.
- Set `created_at` explicitly to `Date.now()` (the `$defaultFn` lives in Drizzle, not in the DB — raw SQL gets no default).

---

## 3. Test plan

Baseline before starting: **471 passing / 2 skipped across 46 files** (per `docs/prd/07-platform-launch/README.md` v0.5). Every acceptance item below is `[machine]`.

### 3.1 `db/schema-invite-codes.test.ts` (new) — schema shape + migration
Modelled on `db/schema-auth.test.ts` (Drizzle introspection + PGlite round-trip, no `DATABASE_URL`).
- `getTableName(inviteCodes) === 'invite_codes'`; column set is exactly `['code','usedBy','usedAt','createdAt']`; DB names are snake_case; `code` is the PK; `usedAt`/`usedBy` are nullable; `createdAt` is NOT NULL.
- `usedAt`/`createdAt` SQL type is `bigint` (schema convention #1).
- The committed migration SQL contains `CREATE TABLE "invite_codes"` and an `invite_codes_used_by_users_id_fk` with **`ON DELETE set null`** — the mechanical guard for §0.9 (c).
- PGlite round-trip: migrate, insert a code, read it back.

### 3.2 `lib/db/queries/invite-codes.test.ts` (new) — the atomicity surface
One PGlite instance per file + `truncate table invite_codes, users restart identity cascade` in `beforeEach`; `30_000` as the third argument everywhere (fact §0.12); inject the client via `{ executor }`.

| Test | Proves |
|---|---|
| valid unused code ⇒ `true`, row has `used_at` set and `used_by` = the passed id | acceptance 1 |
| nonexistent code ⇒ `false`; table byte-identical before/after (snapshot all rows) | acceptance 2 |
| already-used code ⇒ `false` **and the original `used_by`/`used_at` are unchanged** (a second redeemer must not overwrite the first) | acceptance 2 |
| `Promise.all` of two redemptions of the same seeded code ⇒ exactly one `true`, one `false`; exactly one row is marked; `used_by` equals one of the two ids | acceptance 3 |
| the same with 10 parallel redemptions ⇒ exactly one `true` | acceptance 3, stronger |
| `redeemInviteCode(code, null)` ⇒ `true`, `used_at` set, `used_by` stays `NULL` (the production gate path, §0.9 (a)) | §2.4 step 4 |
| `attributeInviteCode` fills `used_by` on a claimed code; is a **no-op** on an unclaimed code and on one whose `used_by` is already set | §2.2 rule 3 |
| **`DELETE FROM users` succeeds for a user who redeemed a code, and afterwards `used_at` is still set while `used_by` is `NULL`** | §0.9 (b)+(c) — the PLT-01 hard-delete regression and the "deleting an account does not free the code" bypass, in one test |
| `hasExistingUserWithEmail`: seeded email ⇒ `true`; unknown, case-variant, `''`, `null`, `undefined` ⇒ `false` | §2.2, acceptance 5 |
| module imports cleanly with `DATABASE_URL` **deleted** (`vi.resetModules()` + `import()`), and the lazy `@/db/index` resolves exactly **once** under same-tick concurrency | copy of `admin.test.ts:501-562`; guards the clean-checkout build |

**The concurrency tests must carry a comment stating their limit** (fact §0.10): PGlite is single-connection, so these prove the *guarded-UPDATE predicate* rejects the second redeemer, not that Postgres's row lock does. The production guarantee rests on READ COMMITTED row locking + EvalPlanQual re-evaluation of `WHERE used_at IS NULL`. Verifying it against real concurrent Neon traffic is the ticket's Feedback obligation #1 and is listed in §5 Q1 as a human item — **do not let a green PGlite test be reported as proof of the production guarantee.**

### 3.3 `auth.test.ts` (append) — the gate, acceptance items 4 and 5
The file already mocks `next-auth` wholesale (lines 22-31), so `@/auth` imports fine. Drive `createInviteGate` with injected fakes — no DB, no PGlite.
- **New user + no cookie ⇒ `false`**, and `redeemInviteCode` was never called (acceptance 4).
- **New user + a code the fake rejects ⇒ `false`** (acceptance 4).
- New user + accepted code ⇒ `true`, `redeemInviteCode` called once with `(code, null)`.
- **Existing user (fake `hasExistingUserWithEmail` ⇒ true) ⇒ `true` with no cookie, and `redeemInviteCode` never called** (acceptance 5). Run it for both `account.type: 'oauth'` and `'email'`.
- Email provider, `email: undefined` (the magic-link click), new user, no cookie ⇒ `true` (§2.4 rule 2); and with `email: { verificationRequest: true }`, new user, no cookie ⇒ `false`.
- `createUser` swallows a throwing `attributeInviteCode`, and is a no-op when no cookie was present.
- `readInviteCodeCookie`: absent header; `gw_invite` among several cookies; URL-encoded value; malformed `%zz`; empty value; a 200-character value; a value with `;`/space; `undefined` request. Each returns the expected value or `undefined`.
- `buildAuthConfig(new Request(url, { headers: { cookie: 'gw_invite=ABC' } }))` returns a config whose `callbacks.signIn` is a function, **whose `callbacks.session` is still `auth.config.ts`'s** (regression guard for FND-08 finding #2), and whose `events.createUser` is a function. Keep the existing zero-arg `buildAuthConfig()` test green.

### 3.4 `app/(auth)/signin/page.test.tsx` (append) — Deliverable 5
jsdom, `@testing-library/react`, `next-auth/react` already mocked. Clear `document.cookie` in an `afterEach`.
- The invite input renders, is labelled, and **is not `required`**.
- Typing a code then submitting the magic-link form sets `document.cookie` to contain `gw_invite=<code>` **and** still calls `signIn('resend', …)` with the email and `callbackUrl: '/home'` (the three existing assertions must stay green).
- Typing a code then clicking **Continue with Google** also sets the cookie and calls `signIn('google', …)`.
- Submitting with the field **empty** clears the cookie (`gw_invite` absent from `document.cookie`) — the shared-browser guard in §2.5 point 2.

### 3.5 `tests/generate-invite-codes.test.ts` (new)
Imports the script's exported pure helpers via a relative path (covered by the `tests/**/*.test.ts` glob).
- `makeCode()` returns the documented length/alphabet; 1000 draws are all distinct; the string satisfies §2.4's `[A-Za-z0-9-]` filter (otherwise a minted code could never be redeemed — a silent end-to-end break neither side's tests would otherwise catch).
- The module source contains **no `Math.random`** (a cheap, direct regression guard for §4 R-5).
- `parseCount`: default, `--count 20`, `0`, `-1`, `abc`, `1001` — accepted or rejected as specified.
- Spawning the script with `DATABASE_URL` unset exits non-zero and prints an actionable message (`execFileSync`/`spawnSync` with `stdio: 'pipe'`, `env` copied minus `DATABASE_URL`; precedent `db/migrate.test.ts:33-62`).

### 3.6 Whole-suite gates (acceptance item 6)
- `pnpm test` green; report the new totals and **confirm every new test file appears in the run output** (fact §0.11).
- `pnpm lint` clean.
- `pnpm build` **exit 0 with no environment variables set at all** — the single most likely way to break this ticket is a static `@/db/index` import reaching `auth.ts`'s graph through `lib/db/queries/invite-codes.ts` (§0.8). This is a required check, not optional.

---

## 4. Risks and edge cases

**R-1 — Concurrency (the ticket's designated P0).** Handled by the single guarded UPDATE (§2.2); the residual risk is that it is unverifiable offline (§0.10). Two ways to get this wrong that the Reviewer should look for specifically: (a) a `SELECT`-then-`UPDATE` implementation, which has a real TOCTOU window; (b) guarding on `used_by IS NULL`, which is the ticket's literal text and is exploitable via account deletion (§0.9 (b)).

**R-2 — Consumption timing for magic links (accepted trade-off, recorded so it is not rediscovered as a bug).** The code is consumed when the magic-link email is *requested*, not when the link is *clicked*. Consequences: a user whose email is lost or spam-filtered cannot retry with the same code (remedy: Horace mints another, or clears `used_at` on that row); a code is burned if the link is never clicked. The alternative — validate at request time, consume at click time — makes retries work but denies anyone who opens the link on a different device, and lets one code trigger unlimited emails. This plan prefers the chosen side because "one code ⇒ one email ⇒ at most one account" is the stronger cost/pacing property (PRD §9) and because cross-device link opening is common. Flipping it is a ~10-line change in §2.4 — §5 Q2.

**R-3 — PII and hard-delete completeness.** `invite_codes` deliberately stores **no email**. Combined with `ON DELETE SET NULL`, a hard-deleted user leaves behind only `code` + `used_at` + `created_at` — nothing user-identifying — so PRD §5.6's "删号 = 硬删该用户全部数据" and §12's PII risk both stay satisfied without PLT-01's route needing to know this table exists. **Any future "store who used it by email" change breaks that and must go back through PLT-01's delete path.**

**R-4 — Cookie is not a security boundary.** `gw_invite` is client-writable by design; it carries a user-supplied value, not a server secret. Every security property comes from the server-side atomic redemption. Two concrete implications: the length/charset filter in §2.4 step 1 must run before the value touches SQL (defence in depth — drizzle parameterises, so this is belt-and-braces, not the primary defence); and nothing may ever be *trusted* because it arrived in this cookie.

**R-5 — Code guessing.** There is no rate limit on redemption attempts. ~60 bits of `node:crypto` entropy over a small live-code population makes online guessing infeasible, so the entropy *is* the control — which is exactly why `Math.random()` is forbidden and why §3.5 asserts against it. If the code format is ever shortened (e.g. to a 6-character human-friendly code), this reasoning collapses and rate limiting becomes mandatory. Note it in the script's header.

**R-6 — Rejected carrier mechanisms** (so nobody re-litigates them mid-build): reading `req.body`/`req.formData()` in `buildAuthConfig` **destroys** the single-use stream `@auth/core` needs and breaks `sendToken`; `next/headers` cannot be added to the Edge-bundled config graph (§0.8); `authorizationParams` are forwarded to Google and would corrupt the OAuth request; smuggling the code into `callbackUrl` leaks it into the post-login address bar, `Referer` headers, and server logs; a pre-flight API route that reserves a code introduces a second, unatomic reservation state and a new file outside the ticket's scope.

**R-7 — Ordering hazard inside `handleAuthorized`.** The gate runs **before** account creation (§0.6). If user creation subsequently fails (e.g. `OAuthAccountNotLinked`, `handle-login.js:250`), the code is already consumed. Low probability, unfixable without a reservation protocol, operationally recoverable by clearing `used_at`. Do not attempt to "un-redeem" in a catch block — that would reintroduce a race.

**R-8 — Existing-user detection depends on a live DB read on every new sign-in.** `hasExistingUserWithEmail` adds one indexed lookup per sign-in attempt (`users.email` is `UNIQUE`). If it throws, the gate fails closed and *existing* users are locked out too, not just new ones. Acceptable for a launch gate; worth stating in the code comment so the blast radius of a DB outage is known before it happens.

**R-9 — Deviations bookkeeping.** §0.9's five ticket deviations plus the two file-scope extensions (`tests/generate-invite-codes.test.ts`, and test appends to `auth.test.ts` / `app/(auth)/signin/page.test.tsx`) must be recorded in the ticket Changelog and surfaced to the Reviewer. Precedent for a test file landing outside literal file scope: PLT-02's `tests/backup.test.ts` (sub-PRD README v0.3).

---

## 5. Open questions

| # | Question | Who decides |
|---|---|---|
| Q1 | The double-redemption guarantee is proven only against PGlite (single-connection). It needs one verification against a real Neon instance under genuine parallel load before P5 sign-off — the ticket's Feedback obligation #1 calls a surviving race here P0. | **Horace** (needs real `DATABASE_URL`; blocked on sub-PRD open question #3). Builder: record it as an explicit `[human]` item in the ticket, do not mark the obligation discharged. |
| Q2 | Consume the code when the magic link is **requested** (this plan) or when it is **clicked**? R-2 states both failure modes. Only Horace can weigh "lost email means a burned code" against "different-device link opening is denied". | **Horace** (product). Default: as planned. Revisit after the first real invite round. |
| Q3 | A rejected sign-in lands on Auth.js's generic `/api/auth/error?error=AccessDenied`, which says nothing about invite codes. Fixing it means a `pages.error` entry in `auth.config.ts` — outside this ticket's file scope. | **Horace** (product) to decide it is worth doing; then a **new ticket** owning `auth.config.ts`, not a scope-creep edit here. |
| Q4 | Is the CLI (`node scripts/generate-invite-codes.mjs --count N`) enough, or should code generation move into `/admin`? | **Horace**, per the ticket's Feedback obligation #2 — and it must become a **new ticket** (it would touch PLT-03's file scope) plus a new row in `docs/prd/07-platform-launch/README.md`'s open questions. Never a retroactive edit to PLT-03 or PLT-04. |
| Q5 | Promote §2.0's cookie-carrier decision to `docs/adr/0001-*.md`? Deferred by design (§2.0): `docs/adr/` is empty and PLT-03 set the precedent of not creating the repo's first ADR for a decision still awaiting confirmation. | **Horace**, at P5 or the moment a second ticket needs the same mechanism. |

---

## 6. Definition of done for this ticket

- [ ] `db/schema.ts` append + generated `0004_*` migration committed (schema, SQL, snapshot, journal).
- [ ] `lib/db/queries/invite-codes.ts` with the single-statement guarded UPDATE, no top-level `@/db/index` import.
- [ ] `auth.ts` gate wired; `auth.config.ts` **unmodified**; `auth.config.test.ts` still green.
- [ ] Sign-in page field + cookie writer covering **both** providers.
- [ ] `scripts/generate-invite-codes.mjs` using `node:crypto`.
- [ ] All six ticket acceptance items covered by named tests (§3).
- [ ] `pnpm test` green (report totals and confirm every new file was collected) · `pnpm lint` clean · `pnpm build` exit 0 **with no env vars set**.
- [ ] §0.9 deviations + §4 R-9 file-scope extensions recorded in the ticket Changelog and flagged for the Reviewer; §5 Q1's human verification listed as still open.
