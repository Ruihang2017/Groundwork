# Implementation plan — FND-08: Auth.js v5 (Google OAuth + magic link) and session/userId scoping helper

Ticket: [docs/prd/01-foundation/tickets/FND-08-authjs-session.md](../prd/01-foundation/tickets/FND-08-authjs-session.md)
Sub-PRD: [docs/prd/01-foundation/README.md](../prd/01-foundation/README.md)
Master spec: [docs/PRD.md](../PRD.md) §8.1 (stack pin: "Auth.js v5（Google OAuth + email magic link via Resend）… 选 Auth.js 而非 Clerk"), §8.3 ("数据隔离：全部查询以 session userId 约束，无跨用户查询路径"), §10 P0 ("注册/登录可用，空应用在线")
Breakdown plan file-ownership table: [docs/prd/breakdown-plan.md](../prd/breakdown-plan.md) §3 (`auth.ts`, `auth.config.ts`, `middleware.ts`, `lib/auth/session.ts`, `app/api/auth/**` → `01-foundation`/FND-08 creates; `07-platform-launch`/PLT-04 appends invite-code validation into the `signIn` callback only — no other cross-module append rights are granted anywhere in this table for these files), general append-only policy (line 41).
Depends on (merged): [docs/plans/FND-05.md](FND-05.md) (`db/schema.ts` — eight tables incl. `users`; `db/index.ts` — Drizzle client, throws at import time if `DATABASE_URL` unset).
Downstream (read this plan's decisions before starting): FND-09 (imports `auth`/`signIn`/`signOut` from `@/auth` for the sign-in page and layout; its own acceptance item 3 literally says "middleware.ts (FND-08) correctly redirects an unauthenticated request to `/(app)` to `/signin`" — confirms `/signin` is the real public URL this plan's middleware allowlist must use); every downstream feature module (LIB-01, FIT-01, PLT-01, PLT-03, PLT-04, etc.) imports `requireUserId()` from `lib/auth/session.ts` as the *only* sanctioned way to get a trustworthy `userId`; PLT-04 imports and wraps this ticket's exported `signIn` callback function (not the `signIn` client action) — see §2.3's resolution of a real ambiguity in the ticket's own wording.

This plan is cold-startable: a Builder with no access to the planning conversation can execute it from this file plus the ticket alone. All external facts below (npm registry contents, Auth.js/Next.js documentation snippets) were fetched live during planning (2026-07-18) and are quoted/cited so the Builder does not need to re-research them, but should spot-check the exact installed package versions once `pnpm install` actually runs, since a beta channel can move between planning and build time.

## 0. Repo-state check performed for this plan (do not re-derive, just confirm unchanged)

Verified at planning time (2026-07-18) by direct inspection, not assumption:

- `git log --oneline`: HEAD is `2e65700` (merge ticket/FND-07 into main). `git branch --list "ticket/FND-08"` is empty — **no in-flight FND-08 branch exists**. Working tree clean. **`2e65700` is the base commit** the Builder's diff should be measured against.
- `db/schema.ts` (FND-05, merged) exports `users`, `libraries`, `resumes`, `jobs`, `tailoredResumes`, `briefs`, `usageEvents`, `evalRuns` plus `jobStatusEnum`/`usageOpEnum`/`evalSuiteEnum`. Its `users` table is exactly:
  ```ts
  export const users = pgTable('users', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    name: text('name'),
    email: text('email').notNull().unique(),
    emailVerified: timestamp('email_verified', { mode: 'date' }),
    image: text('image'),
  });
  ```
  Its top-of-file convention comment already anticipates this ticket by name: "Timestamp columns are `bigint(..., { mode: 'number' })` holding epoch-ms … The one exception is `users.emailVerified`, which stays a native `timestamp` because its shape is dictated by the Auth.js Drizzle adapter contract … Do not 'fix' that exception for consistency — it would break FND-08's adapter wiring." This plan extends that same exception to two more columns this ticket introduces (`sessions.expires`, `verificationTokens.expires` — see §2.2) and instructs updating that comment's wording accordingly (§2.2), not just relying on it silently covering columns it doesn't yet mention.
- `db/index.ts` (FND-05, merged) exports a singleton `db` and **throws at import time if `process.env.DATABASE_URL` is unset** (confirmed by reading `db/index.test.ts`'s own assertions). This is load-bearing for this ticket's testing strategy — see §4's first risk item, it is not optional plumbing to route around casually.
- `db/schema.test.ts` (FND-05, merged) is deliberately structured — per its own header comment — "so FND-08 can re-run this file BYTE-FOR-BYTE UNMODIFIED as its own regression check after appending accounts/sessions/verificationTokens": each of the eight original tables is asserted independently and nothing in the file asserts the *total* count of exported tables. **This plan's regression strategy for acceptance item 4 is: do not touch `db/schema.test.ts` at all; add the three new tables' own assertions in a new file.**
- `.env.example` (current content, verified by direct read) already lists `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL` (added by FND-01) — **no edit needed**, satisfies the ticket's own "verify, do not duplicate" instruction.
- `package.json` (current) has **zero** `next-auth`/`@auth/*` packages in `dependencies`/`devDependencies`, and `node_modules/next-auth`, `node_modules/@auth` do not exist. This ticket must add them (see §2.1) — the ticket's own File-scope section does not explicitly list `package.json`, but Deliverables 1–3 are impossible to implement without adding these packages; FND-05's ticket explicitly listed `package.json` in its own File-scope for the same reason (new runtime deps), and this plan treats that as the established in-module precedent for "a `01-foundation` ticket appending its own new runtime dependency directly, no cross-module append-only caveat applies since `01-foundation` already owns `package.json`" (`breakdown-plan.md` §7: "`package.json`… 是唯一允许‘跨模块追加’的四类文件之一" — the constraint is about *other modules* appending, not about a `01-foundation` ticket adding its own deps to the file `01-foundation` already owns). Record this as a Deviations note at build time (ticket text omitted `package.json` from its own File-scope list; this plan reads that as an oversight, not a prohibition) — flagged again in §5 Open Question #1.
- **npm registry check (live, 2026-07-18):** `next-auth`'s `latest` dist-tag is **`4.24.14`** (Auth.js v4) — v5 only exists under the **`beta`** dist-tag, currently `5.0.0-beta.31`. **The ticket's own illustrative install command implied by its prose (`pnpm add next-auth@5`) would silently install v4, not v5**, because npm resolves a bare major-version range against `latest`-tagged releases only when no matching version exists under that tag's own line — `next-auth@5` actually resolves to the highest *published version whose major is 5*, and since there is no non-beta 5.x published, `next-auth@5` as a semver range specifier `^5.0.0`-ish is not what's being asked here; **empirically `next-auth@5` on npm resolves through the `beta` prerelease space and does install `5.0.0-beta.31`-class versions**, but this is exactly the kind of ambiguous edge case the ticket's own Feedback obligation #1 warns about — **do not assume; the Builder must run `npm view next-auth@5 version` (or equivalent) once, at build time, and confirm the resolved version's major is actually `5` before proceeding, or pin explicitly.** This plan's recommendation, to remove all doubt: **pin the exact verified-compatible pair** `next-auth@5.0.0-beta.31` and `@auth/drizzle-adapter@1.11.2` (see next bullet for why these two are confirmed compatible) rather than relying on the `@beta` dist-tag floating to a newer beta mid-build.
- **Version-compatibility check (live, 2026-07-18):** `@auth/drizzle-adapter@1.11.2`'s only dependency is `@auth/core@0.41.2`. `next-auth@5.0.0-beta.31`'s only dependency is also `@auth/core@0.41.2`. **Same exact `@auth/core` version — confirmed compatible pairing.** `next-auth@5.0.0-beta.31`'s `peerDependencies`: `next: "^14.0.0-0 || ^15.0.0 || ^16.0.0"` (repo has `next@^15.5.20` ✓), `react: "^18.2.0 || ^19.0.0"` (repo has `react@^19.2.7` ✓), plus `@simplewebauthn/browser`, `@simplewebauthn/server`, `nodemailer` — **all three listed in `peerDependenciesMeta` as `{ optional: true }`** (confirmed via `npm view next-auth@5.0.0-beta.31 peerDependenciesMeta`). **Do not install `nodemailer`** — it is only needed for Auth.js's separate Nodemailer/SMTP `Email` provider, not the `Resend` provider this ticket uses (confirmed below). `@auth/drizzle-adapter` declares no `peerDependencies` at all (its `drizzle-orm`/`drizzle-kit` version pins visible in the registry are `devDependencies` for its own test suite only) — no version conflict with the repo's installed `drizzle-orm@^0.45.2`.
- **Resend provider mechanics (confirmed by reading `next-auth`'s own source, `packages/core/src/providers/resend.ts` at the `main` branch, 2026-07-18):** the built-in `Resend` provider (`import Resend from "next-auth/providers/resend"`) sends the magic-link email via a direct `fetch("https://api.resend.com/emails", …)` call inside its `sendVerificationRequest` — **no `resend` npm SDK package is used or needed.** Its config shape is `Resend({ apiKey, from })` (both required, no auto-env-var reads for this specific provider) — map `apiKey: process.env.RESEND_API_KEY`, `from: process.env.RESEND_FROM_EMAIL` explicitly in `auth.config.ts` (§2.3). This provider's `id` is `"resend"` and `type` is `"email"` — matches the ticket Non-goals' `signIn('resend', { email })` call-site reference and FND-09's own planned usage.
- **Route handler file convention (confirmed live from `authjs.dev`'s versioned installation docs, `?framework=next.js`, 2026-07-18):** the documented path is literally `./app/api/auth/[...nextauth]/route.ts`, containing:
  ```ts
  import { handlers } from "@/auth" // Referring to the auth.ts we just created
  export const { GET, POST } = handlers
  ```
  This matches the ticket's own anticipated path exactly (Goal: "`app/api/auth/[...route]/route.ts` (exact segment name per the installed Auth.js v5 version's convention)") — **no divergence found; confirm-and-proceed, no Feedback-obligation-#1 changelog entry is strictly required for this specific detail** (still worth one line in the ticket's own changelog stating "confirmed, no change" per §2.9, so a future reader knows it was checked rather than assumed).
  ```ts
  export const { handlers, auth, signIn, signOut } = NextAuth({ … })
  ```
  is confirmed as Auth.js v5's real, current export shape (same source, `apps/examples/nextjs/auth.ts`) — matches ticket Deliverable 2 exactly.
- **`@auth/drizzle-adapter`'s canonical Postgres column shapes (confirmed by reading its own source, `packages/adapter-drizzle/src/lib/pg.ts`, `main` branch, 2026-07-18)** — this is the exact, load-bearing contract `db/schema.ts`'s new tables must satisfy (reproduced and adapted in §2.2; do not improvise a different shape):
  ```ts
  // accounts (upstream default table name "account")
  {
    userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  }
  // composite primary key: (provider, providerAccountId)

  // sessions (upstream default table name "session")
  {
    sessionToken: text("sessionToken").primaryKey(),
    userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  }

  // verificationTokens (upstream default table name "verificationToken")
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  }
  // composite primary key: (identifier, token)
  ```
  **Critical, non-obvious fact:** the *property names* `refresh_token`, `access_token`, `expires_at`, `token_type`, `id_token`, `session_state` are themselves snake_case in the TypeScript object (not just the DB column string) — they mirror OAuth2's own wire-format field names verbatim, because `@auth/core`'s `AdapterAccount` type defines them that way and `DrizzleAdapter`'s `linkAccount()` does `client.insert(accountsTable).values(data)` with `data: AdapterAccount` matched by property key. **These exact property names are structurally enforced by TypeScript** when the table object is passed to `DrizzleAdapter(db, { accountsTable: accounts, … })`, because the adapter package exports `DefaultPostgresAccountsTable`/`DefaultPostgresSessionsTable`/`DefaultPostgresVerificationTokenTable` types requiring exactly these property names — a Builder who "cleans up" these to camelCase will get a **compile error at the `DrizzleAdapter(...)` call site**, not a silent runtime bug. Do not rename them despite them looking inconsistent with this repo's other camelCase-JS/snake_case-DB convention.
- **`users` table needs zero changes.** Cross-checking FND-05's existing `users` columns field-by-field against `DefaultPostgresUsersTable`'s type constraints (`id`: primary key, not-null, string ✓; `name`/`email`/`image`: `notNull: boolean` — accepts either, so `.notNull().unique()` on `email` is fine ✓; `emailVerified`: `dataType: "date"`, `columnType: "PgTimestamp"` — matches `timestamp('email_verified', { mode: 'date' })` exactly ✓) — **no adjustment is required**, resolving the ticket Deliverable 1 parenthetical "(and any adjustments to `users` the Drizzle adapter's type requires)" as **none needed**. This also means `db/schema.test.ts`'s existing `users` assertions stay green with zero risk, trivially satisfying half of acceptance item 4.
- **Database-strategy session `user.id` wiring (confirmed via `authjs.dev/guides/extending-the-session`, 2026-07-18) — this is the single most important, non-obvious fact this plan surfaces; the ticket text does not mention it at all.** By default, Auth.js's `Session.user` type/object has **no `id` field**. With `session: { strategy: 'database' }`, the documented, required pattern to populate `session.user.id` is a `callbacks.session` function:
  ```ts
  callbacks: {
    session({ session, user }) {
      session.user.id = user.id
      return session
    },
  }
  ```
  (the `user` argument here is the full `AdapterUser` row the adapter fetched from the DB — only available because of the database session strategy; the JWT-strategy equivalent uses `token.id` instead and is *not* what this ticket needs). **Without this callback, `requireUserId()` would compile and its unit tests (which mock `auth()` and fabricate `{ user: { id: '...' } }` directly) would pass, but in real, non-mocked usage `session.user.id` would always be `undefined`, making `requireUserId()` throw `UnauthorizedError` for every real signed-in user** — a production-breaking bug invisible to this ticket's own mocked test suite. See §2.3 (must-implement) and §4 (flagged as the top mock-passes-but-real-breaks risk).
  A companion TypeScript module augmentation is also documented (`authjs.dev/getting-started/typescript`) and needed so `session.user.id` type-checks anywhere in the app:
  ```ts
  declare module 'next-auth' {
    interface Session {
      user: { id: string } & DefaultSession['user'];
    }
  }
  ```
- **Edge runtime / database-session interaction (confirmed via `authjs.dev/guides/edge-compatibility`, "Split Config" section, 2026-07-18).** Auth.js's own documented default guidance for combining Middleware/Proxy with a database session strategy is to run a **separate, adapter-less, JWT-strategy** Auth.js instance in `middleware.ts`/`proxy.ts` (because "every `auth()` call will trigger a database query" and most DB adapters cannot run inside the Edge runtime at all). **This ticket's Deliverable 1 explicitly does not ask for that split** — it asks for one `auth.config.ts` holding the full config (adapter included) and one `auth.ts` instance built from it, used everywhere including `middleware.ts`. This plan **keeps the ticket's literal, simpler design** rather than introducing an unrequested split-config architecture, because the specific reason the official guide's Edge concern usually applies (most DB adapters need raw TCP sockets, unavailable at the Edge) **does not apply to this stack**: FND-05's `db/index.ts` uses `drizzle-orm/neon-http` + `@neondatabase/serverless`, an explicitly HTTP-`fetch`-based, Edge/serverless-compatible driver — the entire `DrizzleAdapter` query path this ticket wires up should function inside Next.js's default Edge middleware runtime. This is flagged, not silently assumed — see §4's second risk item for the concrete, low-cost fallback (`export const config = { runtime: 'nodejs' }`, confirmed stable in Next.js since v15.5 via version-pinned docs, and this repo is pinned to `next@^15.5.20`) if empirical testing (which the Builder can only do once Horace provisions real `DATABASE_URL`/OAuth credentials, per the ticket's own Feedback obligation #2) surfaces an actual incompatibility.
- **`middleware.ts` file convention (confirmed via `nextjs.org/docs/15/...` — version-pinned to exactly `15.5.20`, matching this repo's installed range, 2026-07-18):** file lives at the project root (same level as `app/`), must export a single function as either the default export or a function named `middleware`, defaults to the Edge runtime, and **"As of v15.5, we have support for using the Node.js runtime. To enable, in your middleware file, set the `runtime` to `nodejs` in the `config` object."** Also confirmed: **"As of Next.js 16, `middleware.ts` has been renamed to `proxy.ts`."** Since this repo pins `next@^15.5.20` (not 16), `middleware.ts` — the ticket's literal filename — is correct; flagged in §4/§5 as a known future-upgrade migration point, not something to act on now.
- **Route-group URL-path fact (Next.js App Router semantics, not version-specific):** `app/(app)/**`, `app/(auth)/**`, `app/(legal)/**` are *route groups* — the parenthesized segment is invisible in the actual request URL. **"Protect `app/(app)/** ` routes" cannot be expressed as a literal path-prefix matcher** (there is no `/(app)/...` URL ever requested) — it must be expressed as "protect every URL path except the known-public ones." At planning time, no pages exist yet under `app/(app)/**` or `app/(auth)/**` (FND-09 has not run) — the only two public URL paths this ticket can concretely know about are **`/`** (root landing page, `app/page.tsx`, already exists as FND-01's placeholder) and **`/signin`** (confirmed as the real, literal URL by cross-referencing FND-09's own ticket text: "middleware.ts (FND-08) correctly redirects an unauthenticated request to `/(app)` to `/signin`" — the `/(app)` there is FND-09's own shorthand for the same route-group-invisibility fact, `/signin` is the literal target). §2.5 designs the matcher/allowlist around exactly these two known public paths, structured so a later ticket can extend the allowlist (see §5 Open Question #3 — no module currently holds explicit append rights to `middleware.ts` for this purpose per `breakdown-plan.md`'s file-ownership table, which is itself a gap worth flagging upstream, not this ticket's to fix).
- **`Google` provider (standard, no live-doc fetch needed beyond confirming the import path already referenced by the `apps/examples/nextjs/auth.ts` fetch above):** `import Google from "next-auth/providers/google"`, called as `Google({ clientId: process.env.AUTH_GOOGLE_ID, clientSecret: process.env.AUTH_GOOGLE_SECRET })`. Auth.js v5 also supports a bare, uncalled `providers: [Google]` form that auto-infers credentials from `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET` env vars by naming convention — this plan uses the explicit called form (matching the ticket's own literal `Google({...})` Deliverable 1 text, and for symmetry with `Resend({...})`, which has no auto-inference option at all) — noted as a low-stakes implementation-detail choice, not a correctness requirement either way.

## 1. Scope

**In scope** (mirrors the ticket's own Goal/Deliverables — restated here for a single at-a-glance list; the ticket file remains the source of truth for exact wording):

- `auth.config.ts` (new, repo root) — full `NextAuthConfig`: Google + Resend providers, `DrizzleAdapter` bound to `db` + the new `accounts`/`sessions`/`verificationTokens`/existing `users` tables, `session: { strategy: 'database' }`, a named+exported `signInCallback` (no-op allow-all, PLT-04's future extension point), a `session` callback wiring `session.user.id = user.id`.
- `auth.ts` (new, repo root) — `export const { handlers, auth, signIn, signOut } = NextAuth(authConfig)`, plus the `declare module 'next-auth'` `Session.user.id` TypeScript augmentation.
- `app/api/auth/[...nextauth]/route.ts` (new) — `export const { GET, POST } = handlers`.
- `middleware.ts` (new, repo root) — protects every page route except `/`, `/signin`, and Next.js/API internals; redirects unauthenticated requests to `/signin`.
- `lib/auth/session.ts` (new) — `UnauthorizedError` class + `requireUserId(): Promise<string>`.
- `db/schema.ts` (append) — `accounts`, `sessions`, `verificationTokens` tables, `primaryKey` import, one comment-block update (no changes to any of the eight existing tables).
- `package.json` (append) — `next-auth`, `@auth/drizzle-adapter` runtime dependencies (`pnpm-lock.yaml` regenerates as a side effect of `pnpm install`).
- `vitest.config.ts` (append) — widen `test.include` to discover root-level test files this ticket adds (see §2.9 — currently only `tests/**`, `lib/**`, `db/**` are covered, none of which match a root-level `middleware.test.ts`/`auth.config.test.ts`).
- New test files: `db/schema-auth.test.ts` (or equivalent name under `db/`), `lib/auth/session.test.ts`, `middleware.test.ts` (root), `auth.config.test.ts` (root) — exact filenames at Builder's discretion, coverage requirements fixed in §3.
- `docs/prd/01-foundation/README.md` — one changelog line (v0.4 → v0.5).
- `docs/prd/01-foundation/tickets/FND-08-authjs-session.md` — version bump + changelog line recording the version pins, the `signIn`-callback-vs-`signIn`-action disambiguation (§2.3), and the `session.user.id` wiring requirement this plan surfaced (§0) — per the ticket's own Feedback obligation #1's "record the divergence… rather than forcing a stale API shape" instruction, applied here to "a materially important detail the ticket didn't mention at all," which is the same spirit even though it is not literally a contradiction of a named mechanical detail.

**Explicitly out of scope** (per ticket Non-goals — do not implement, even opportunistically):

- No invite-code validation logic inside `signInCallback` — it must remain a trivial `return true`, named and exported so `07-platform-launch`/PLT-04 can wrap it later (§2.3).
- No `app/(auth)/signin/page.tsx` — FND-09's file; this ticket's route handlers/exports are what that (not-yet-existing) page will call into.
- No `lib/db/queries/**` files of any kind.
- No admin-role column or claim on `users`.
- No account-deletion logic.
- No real Google OAuth client registration, no real Resend account/domain verification, no live end-to-end sign-in test — this ticket's own tests mock `auth()`/the adapter/providers entirely (ticket Feedback obligation #2); the `[human]` acceptance item is Horace's, not this plan's to satisfy.
- No `app/(legal)/**` allowlisting in `middleware.ts` — those pages don't exist yet (`07-platform-launch` creates them); §5 Open Question #3 flags the unresolved question of *which* future ticket gets to extend the allowlist and how.

## 2. Change list

### 2.1 `package.json` — new dependencies

Append to `dependencies` (both pinned to the exact versions verified compatible in §0 — do not use a floating `@beta`/`@latest` tag for the build):

```json
"@auth/drizzle-adapter": "1.11.2",
"next-auth": "5.0.0-beta.31"
```

Do not add `nodemailer`, `@simplewebauthn/browser`, or `@simplewebauthn/server` — all three are optional peers of `next-auth`, unused by this ticket's Google/Resend-only provider set (§0). `pnpm install` may print an "unmet optional peer dependency" style notice for these — expected, not an error, do not silence it by installing them.

Run `pnpm install` once these two lines are added; `pnpm-lock.yaml` regenerates automatically as a side effect — do not hand-edit the lockfile.

### 2.2 `db/schema.ts` — append three tables (no edits to any existing table)

Add `primaryKey` to the existing `drizzle-orm/pg-core` import list (currently: `bigint, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp` — insert `primaryKey` alphabetically per the file's existing import-sorting style).

Append after the `eval_runs` table (end of file), preceded by a section comment matching the file's existing house style:

```ts
// --- accounts / sessions / verificationTokens (Auth.js Drizzle-adapter tables) --
// Column shapes are dictated verbatim by @auth/drizzle-adapter's own Postgres
// reference schema (packages/adapter-drizzle/src/lib/pg.ts) — do NOT rename any
// property (JS object key) here for camelCase/consistency with this file's other
// tables; DrizzleAdapter(db, { accountsTable: accounts, ... }) type-checks each
// table against @auth/drizzle-adapter's own DefaultPostgres*Table types, which
// require these exact property names (including the snake_case-looking
// refresh_token/access_token/expires_at/token_type/id_token/session_state on
// accounts — those mirror OAuth2's own wire-format field names, not a style
// choice). DB-level column name strings (the first arg to text()/integer()/etc.)
// ARE free to follow this file's own snake_case convention; only the JS property
// keys are load-bearing. `expires` on sessions/verificationTokens is a native
// Postgres `timestamp` (JS Date), the SAME Auth.js-adapter-contract exception
// `users.emailVerified` above already documents — see this file's top-of-file
// convention comment, point 1, updated to name these two columns explicitly.
// accounts.expires_at is a raw OAuth2 token-expiry value in UNIX SECONDS (not
// epoch-ms, not a Date) — a third-party wire value, not one of this app's own
// bigint-epoch-ms timestamp columns; do not "fix" it to bigint/ms.

export const accounts = pgTable(
  'accounts',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').$type<'oauth' | 'oidc' | 'email' | 'webauthn'>().notNull(),
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
```

Notes:
- `type` on `accounts`: upstream's `AdapterAccountType` is `'oauth' | 'oidc' | 'email' | 'webauthn'` — reproduce this literal union rather than a bare `string` `.$type<T>()`, so a typo'd provider type fails to compile the same way the rest of this file's `.$type<T>()` usages do (per this file's own established `jsonb`-typing convention, extended here to a text column).
- No index beyond the primary keys is added on any of the three tables — this deliberately matches `@auth/drizzle-adapter`'s own reference schema exactly (it defines no secondary indexes either); do not invent one the upstream contract doesn't have.
- Update this file's existing top-of-file convention comment (point 1, the timestamp-column paragraph) to read (diff-style, illustrative — exact wording at Builder's discretion): append ", `sessions.expires`, and `verificationTokens.expires` (FND-08)" to the sentence currently naming only `users.emailVerified` as the native-`timestamp` exception, so the file's own self-documentation stays accurate after this append (§0 flags this as required, not optional polish).

**Migration:** FND-05's ticket/plan established "every subsequent `db/schema.ts` change… must run `pnpm db:generate` to produce a NEW migration file. Never hand-edit an existing `db/migrations/*.sql`." This ticket's Deliverables don't explicitly list "run `db:generate`" as a numbered item, but it is required by that already-established repo convention and by `db/migrate.test.ts`'s Tier 2 (static SQL assertions against the *committed* migration) — a second migration file (e.g. `db/migrations/0001_*.sql`) covering the three new tables must be generated for real (never hand-authored) as part of this ticket's own deliverable, even though the ticket text doesn't say so explicitly. Flag as a Deviations-note-worthy addition, not a scope violation (same reasoning FND-05's own plan used for its `vitest.config.ts` writeback).

### 2.3 `auth.config.ts` (new file, repo root)

```ts
import type { AdapterAccountType } from '@auth/core/adapters'; // if needed for typing; otherwise omit
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import type { NextAuthConfig } from 'next-auth';
import Google from 'next-auth/providers/google';
import Resend from 'next-auth/providers/resend';

import { db } from '@/db/index';
import { accounts, sessions, users, verificationTokens } from '@/db/schema';

// PLT-04 (07-platform-launch) wraps or replaces this function to add invite-code
// gating (PRD §9) — kept as a named, exported function (not inlined into the
// `callbacks` object below) specifically so PLT-04 can import and compose it
// without restructuring this file (ticket Non-goals). FND-08's own scope has no
// invite-code check: always allow.
export async function signInCallback(): Promise<boolean> {
  return true;
}

const authConfig = {
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
    Resend({
      apiKey: process.env.RESEND_API_KEY,
      from: process.env.RESEND_FROM_EMAIL,
    }),
  ],
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: 'database' },
  callbacks: {
    signIn: signInCallback,
    session({ session, user }) {
      // Required for database-strategy sessions: Session.user has no `id` field
      // by default (see plan §0's "database-strategy session user.id wiring"
      // note) — without this, requireUserId() always throws in real (non-mocked)
      // usage even for a genuinely signed-in user.
      if (session.user) session.user.id = user.id;
      return session;
    },
  },
} satisfies NextAuthConfig;

export default authConfig;
```

Notes:
- `AUTH_SECRET` needs no explicit code — Auth.js v5 reads it from `process.env.AUTH_SECRET` automatically.
- Remove the `AdapterAccountType` import line if the `accounts.type` column's inline union (§2.2) is used instead of importing the type from `@auth/core` — Builder's choice, keep whichever avoids an unused-import lint failure.
- **Resolving a real ambiguity between the ticket's Deliverable 2 and its own Background/Non-goals sections:** Deliverable 2 says "`signIn` is exported as a named, wrapped function… specifically so PLT-04 has one clean extension point for the invite-code check" — but Background says "PLT-04 appends an invite-code check into this ticket's `signIn` **callback**" and Non-goals says "this ticket only leaves the `signIn` **callback** extensible, e.g. by keeping it a named, exported function… rather than an inline anonymous callback." Auth.js has *two different things* both colloquially called "signIn": (a) the `callbacks.signIn(params)` config function that gates whether a sign-in attempt is allowed — this is where invite-code validation actually belongs, and where PLT-04 will actually plug in; and (b) the `signIn(...)` *action* function exported from `NextAuth()` that a client component calls to *initiate* an OAuth/magic-link flow (`signIn('google')`) — this has no natural connection to invite-code gating. Non-goals' wording is unambiguous and matches Auth.js's real mechanics; this plan treats Non-goals as authoritative and implements (a) — a named, exported `signInCallback` function — as the real extension point. Deliverable 2's exported `{ signIn }` action (in `auth.ts`, §2.4) is produced automatically by the standard `NextAuth()` destructure and needs no extra "wrapping" — that requirement is satisfied by construction, not by any additional code. Flagged for the Reviewer in §5 Open Question #2; the two readings do not conflict in practice (both end up implemented), this is purely a documentation-precision note.

### 2.4 `auth.ts` (new file, repo root)

```ts
import NextAuth, { type DefaultSession } from 'next-auth';

import authConfig from '@/auth.config';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
    } & DefaultSession['user'];
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
```

(`@/auth.config` resolves via `tsconfig.json`'s existing `@/*` → repo-root path alias — confirm at build time that a root-level file resolves through this alias the same way `@/db/schema` etc. already do; if the bundler/TS resolver has any issue with the bare-root case, a relative `./auth.config` import is an equally correct, lower-risk fallback with zero behavioral difference.)

### 2.5 `middleware.ts` (new file, repo root)

```ts
import { NextResponse } from 'next/server';

import { auth } from '@/auth';

// Route groups (app/(app)/**, app/(auth)/**, app/(legal)/**) are invisible in the
// actual request URL — "protect app/(app)/** routes" (ticket Deliverable 4) is
// therefore implemented as "protect every page route EXCEPT this explicit
// allowlist," not as a literal `/(app)/...` path matcher (which would never
// match any real request — see plan §0). Extend this set, not the matcher below,
// when a later ticket adds new public pages (e.g. app/(legal)/** — see plan §5
// Open Question #3 for who owns that edit).
const PUBLIC_PATHS = new Set<string>([
  '/', // app/page.tsx — public landing page
  '/signin', // app/(auth)/signin/page.tsx (FND-09) — must stay reachable while logged out
]);

export default auth((req) => {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  if (!req.auth) {
    const signInUrl = new URL('/signin', req.nextUrl.origin);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
});

export const config = {
  // Excludes /api/** entirely (every API route enforces its own auth via
  // requireUserId() — see lib/auth/session.ts — and /api/auth/** specifically
  // MUST stay reachable unauthenticated or the OAuth/magic-link flow itself
  // breaks) and Next.js's own static/image/favicon internals. This mirrors
  // Auth.js's own official example matcher.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
  // If empirical testing (once Horace provisions real DATABASE_URL/OAuth
  // credentials — this repo has neither yet) shows the Edge runtime rejects
  // the Drizzle/neon-http adapter call inside auth() above, uncomment:
  // runtime: 'nodejs', // stable since Next.js 15.5 (this repo pins ^15.5.20)
};
```

**Critical correctness note, not optional:** if `/api/**` (or at minimum `/api/auth/**`) is ever accidentally included in the protected set, the sign-in flow itself breaks (the OAuth callback / magic-link verification endpoints would get redirected to `/signin` before they can complete), producing a redirect loop or a broken login for every user. This must be covered by a dedicated test (§3).

### 2.6 `app/api/auth/[...nextauth]/route.ts` (new file)

```ts
import { handlers } from '@/auth';

export const { GET, POST } = handlers;
```

### 2.7 `lib/auth/session.ts` (new file)

```ts
import { auth } from '@/auth';

export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

// The ONE chokepoint every downstream API route (every module: LIB, FIT, TLR,
// PRP, PLT) must call first to get a trustworthy userId for query scoping (PRD
// §8.3's "全部查询以 session userId 约束" mandate). Never returns undefined/empty
// silently — always throws UnauthorizedError instead, so a route that forgets to
// handle the error surfaces as a 500 (loud) rather than a cross-user query bug
// (silent).
export async function requireUserId(): Promise<string> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    throw new UnauthorizedError();
  }
  return userId;
}
```

Downstream API routes (out of this ticket's scope to implement) are expected to `catch (e) { if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); throw e; }` — `UnauthorizedError` must be exported precisely so that pattern type-checks and works by `instanceof`, not by string-matching an error message.

### 2.8 `.env.example` — verify only

Already contains `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL` (§0) — confirm at build time this is still true (nothing else should have changed it since planning) and make no edit.

### 2.9 `vitest.config.ts` — widen `test.include`

Current: `['tests/**/*.test.ts', 'lib/**/*.test.ts', 'db/**/*.test.ts']`. This ticket's `lib/auth/session.test.ts` and `db/schema-auth.test.ts` are already covered by the existing `lib/**`/`db/**` globs — **no change needed for those**. But `middleware.test.ts` and `auth.config.test.ts` (§3) are recommended to be **colocated at the repo root**, next to `middleware.ts`/`auth.config.ts` (matching this repo's dominant colocation convention — `db/schema.ts`+`db/schema.test.ts`, `lib/config/quota.ts`+`quota.test.ts` — rather than dropped into `tests/`, which so far only holds infra-level smoke/toolchain tests). **No existing glob matches a root-level `*.test.ts` file** — add one, e.g.:

```ts
include: ['tests/**/*.test.ts', 'lib/**/*.test.ts', 'db/**/*.test.ts', '*.test.ts'],
```

This is the same precedented writeback FND-02/FND-05 each made when their own new test files landed somewhere the existing glob didn't reach (`01-foundation/README.md` v0.3/v0.4 changelog entries name this exact failure mode: "`pnpm test` 会假绿（跑 0 条本票断言）"). **Verify by running `pnpm test` and confirming the test-runner's own output actually lists the new root-level file(s) as executed — checking only the exit code is not sufficient**, since a glob miss here would report a false green with zero of this ticket's own middleware/config assertions ever run. (Alternative, equally valid: skip this `vitest.config.ts` edit entirely and put `middleware.test.ts`/`auth.config.test.ts` under `tests/` instead, which already matches `tests/**/*.test.ts` — Builder's choice; either way, the "confirm actually discovered" verification step is mandatory.)

## 3. Test plan

Maps to the ticket's acceptance checklist; every item below is fully offline (no live Neon, no real Google/Resend credentials — matches ticket Feedback obligation #2).

1. **`requireUserId()` — acceptance items 1–2.** New file `lib/auth/session.test.ts`. Mock the whole `@/auth` module *before* importing `lib/auth/session.ts` (Vitest hoists `vi.mock` calls, so this is safe regardless of import order in the source file):
   ```ts
   vi.mock('@/auth', () => ({ auth: vi.fn() }));
   import { auth } from '@/auth';
   import { requireUserId, UnauthorizedError } from '@/lib/auth/session';
   ```
   - Case: `vi.mocked(auth).mockResolvedValue(null)` → `await expect(requireUserId()).rejects.toThrow(UnauthorizedError)`.
   - Case: `vi.mocked(auth).mockResolvedValue({ user: { id: 'user-123' } } as any)` → `await expect(requireUserId()).resolves.toBe('user-123')`.
   - Case (recommended addition, not explicitly in the ticket's checklist but proving the same "never silently undefined" guarantee the ticket's Deliverable 5 text states): `vi.mocked(auth).mockResolvedValue({ user: {} } as any)` (session present, `user.id` missing/undefined) → also rejects with `UnauthorizedError`, not a resolved `undefined`.
   - **Why mocking `@/auth` (not just `next-auth`) is required, not a style choice:** `@/auth` transitively imports `@/auth.config` → `@/db/index`, and `db/index.ts` **throws at import time** if `process.env.DATABASE_URL` is unset (§0). Without mocking `@/auth` itself, this test file would fail in any environment without a real/dummy `DATABASE_URL` set — breaking this repo's established "no live DB assumed in any test" convention (FND-05's own precedent). Mocking `@/auth` (not a deeper layer) also sidesteps needing to mock Google/Resend network calls or the Drizzle adapter at all.

2. **`middleware.ts` — acceptance item 3.** New file `middleware.test.ts` (root, or `tests/middleware.test.ts` — see §2.9). Same `vi.mock('@/auth', ...)` requirement applies (`middleware.ts` imports `@/auth` at module top level). Mock `auth` as a pass-through higher-order function so the test can capture and directly invoke the inner request handler:
   ```ts
   vi.mock('@/auth', () => ({
     auth: (handler: (req: any) => unknown) => handler,
   }));
   const middlewareModule = await import('@/middleware'); // or relative import
   ```
   - **Matcher/config assertions:** `middlewareModule.config.matcher` excludes `api` (assert the matcher string/array does not match a sample path like `/api/auth/session` — either by literal string inspection or by constructing the equivalent `RegExp` and testing it, whichever is simpler given the matcher's exact emitted shape) and does not special-case `/(app)`, `/(auth)`, `/(legal)` as literal path segments (since those can never appear in a real URL — confirms §0's route-group finding was actually acted on, not just noted).
   - **Redirect behavior, unauthenticated:** construct a fake request object with the minimal shape the handler destructures (`{ nextUrl: new URL('http://localhost/jobs'), auth: null }` — using the real `URL` global is simplest; using `next/server`'s `NextRequest` is also acceptable if constructing one this way proves straightforward, but is not required) and call `middlewareModule.default(fakeReq)`. Assert the result is a redirect response whose `Location`/`.headers.get('location')` (or equivalent, depending on what shape `NextResponse.redirect(...)` exposes in the Node test environment) points at `/signin`.
   - **Pass-through behavior, authenticated:** same fake request but `auth: { user: { id: 'user-123' } }` and `nextUrl.pathname = '/jobs'` → assert the result is *not* a redirect (i.e., `NextResponse.next()`'s marker — check via absence of a redirect status/location, or whatever property distinguishes it once actually run against the installed `next` version).
   - **Public-path pass-through:** `nextUrl.pathname = '/'` and `nextUrl.pathname = '/signin'`, with `auth: null` (unauthenticated) — assert both pass through with **no** redirect, proving the allowlist actually short-circuits before the auth check.
   - **Regression guard for the critical correctness note in §2.5:** assert that a path like `/api/auth/session` is excluded by the matcher (not intercepted at all) — this is the test that would have caught a broken sign-in flow before it ever reached a human tester.

3. **`db/schema.ts` regression + new-table shape — acceptance item 4 + Test-plan's "schema-append regression test."** Do **not** modify `db/schema.test.ts` (§0 — it is deliberately structured to be re-run byte-for-byte unmodified). Add a new file, e.g. `db/schema-auth.test.ts`, importing `accounts`, `sessions`, `verificationTokens` from `@/db/schema` (pure Drizzle introspection via `getTableColumns`/`getTableName`/`getPrimaryKey`-equivalent — no `db/index.ts` import, no `DATABASE_URL` needed, same pattern as `db/schema.test.ts` itself) and asserting:
   - Each table's column-key set matches §2.2's design exactly (including the literal `refresh_token`/`access_token`/etc. property names on `accounts` — this is the regression guard for the "TypeScript will catch a rename, but let's also have an explicit named-key assertion visible in the test output" belt-and-suspenders case).
   - `accounts`'s primary key is the composite `(provider, providerAccountId)`; `verificationTokens`'s is `(identifier, token)`; `sessions`'s is `sessionToken` alone (Drizzle's introspection API for composite primary keys — confirm the exact accessor on the installed `drizzle-orm@^0.45.2` at build time, e.g. via `getTableConfig(table).primaryKeys` or equivalent; do not guess the API shape without checking the installed version's actual exports).
   - `sessions.expires`/`verificationTokens.expires` are native-timestamp columns (`.notNull` true, and — if easily introspectable — the underlying SQL column type is `timestamp`, not `bigint`), and `accounts.expires_at` is an `integer`, not a `bigint`/`timestamp` — regression guard against someone "fixing" it to match this file's dominant bigint-epoch-ms convention (§2.2's inline comment warns against exactly this).
   - **Run `db/schema.test.ts` unmodified alongside this new file** (it already will, as part of `pnpm test`) and confirm all its existing assertions for the original eight tables still pass — this literally *is* acceptance item 4 ("`db/schema.ts` … still passes FND-05's own schema-shape tests unchanged for the original eight tables").
   - Migration regression: extend or add a `db/migrate.test.ts`-style Tier-1/Tier-2 check (reusing FND-05's own established pattern — see `db/migrate.test.ts`) confirming the newly-generated second migration file (§2.2's migration note) actually contains `CREATE TABLE "accounts"`/`"sessions"/"verification_tokens"` statements. Not explicitly named in the ticket's acceptance checklist, but required by the same "never hand-edit, always verify the generated SQL" discipline FND-05 established and this ticket inherits.

4. **`auth.config.ts` real-wiring shape test (recommended addition, proving Deliverable 1's literal text — same justification pattern FND-05's plan used for its own `db/index.test.ts` addition).** New file `auth.config.test.ts` (root). This test does **not** mock `@/auth`/`@/auth.config` — instead, following `db/index.test.ts`'s already-proven-safe pattern, set a syntactically valid dummy `DATABASE_URL` (`vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@fake-host.example.invalid/db')`, `vi.unstubAllEnvs()` in `afterEach`) before importing the real `@/auth.config`, and assert:
   - `authConfig.providers` has exactly two entries whose `.id` are `'google'` and `'resend'` (Auth.js providers expose an `id` field on the object each provider factory returns).
   - `authConfig.session.strategy === 'database'`.
   - `authConfig.adapter` is defined (constructing `DrizzleAdapter(db, {...})` does not throw with only a dummy connection string — matches FND-05's own confirmed fact that `neon()`/`drizzle()` construction is lazy and network-free).
   - `signInCallback` is exported from the module and resolves to `true` when called with no session context (confirms the extension point is a real, importable, named function per §2.3's resolution — this is what actually proves the ticket's Non-goals requirement, not just an unenforced convention).
   This is the ONE test in this ticket's suite permitted to import the real (non-mocked) `@/auth.config` — every other test file must mock `@/auth` per items 1–2's explicit reasoning.

5. **`pnpm test` green — the standing acceptance item.** Run once at the end, and — per §2.9's explicit instruction — inspect the test-runner's own output listing to confirm every new file above (`lib/auth/session.test.ts`, `middleware.test.ts` or `tests/middleware.test.ts`, `auth.config.test.ts`, `db/schema-auth.test.ts`, and any `db/migrate.test.ts` extension) was actually discovered and executed, not just that the process exit code is 0.

6. **`pnpm build` (or `pnpm exec tsc --noEmit`) once**, after every file above is complete — the same "cheap insurance beyond Vitest's non-typechecking transpile" rationale FND-04/FND-05's plans already used, particularly important here given the `DrizzleAdapter(db, { accountsTable: accounts, ... })` compile-time contract check (§0/§2.2) that only `tsc` (not Vitest's esbuild transform) actually enforces.

7. `git diff --stat 2e65700..HEAD` (base commit confirmed in §0) should list exactly: `auth.ts`, `auth.config.ts`, `middleware.ts`, `lib/auth/session.ts`, `app/api/auth/[...nextauth]/route.ts`, `db/schema.ts`, `db/migrations/**` (one new migration), the new test files enumerated above, `package.json`, `pnpm-lock.yaml`, `vitest.config.ts` (if the root-glob path was taken), `docs/prd/01-foundation/README.md`, `docs/prd/01-foundation/tickets/FND-08-authjs-session.md`. Anything else — in particular any edit inside `app/(auth)/**`, `app/(app)/**`, `lib/db/queries/**`, or any of `db/schema.ts`'s eight pre-existing tables — is a File-scope violation and must be reverted before merge.

## 4. Risks & edge cases

- **Mock-passes-but-real-breaks risk (the single highest-priority item in this plan): the `session.user.id = user.id` callback (§2.3) is required for `requireUserId()` to work at all against a real session, and nothing in the ticket's own literal Deliverable/acceptance text names this requirement.** Every acceptance-checklist test for `requireUserId()` mocks `auth()` directly with a hand-fabricated `{ user: { id: '...' } }` object — such tests would pass green even if `auth.config.ts`'s `session` callback were missing entirely, because the mock never exercises the real Auth.js session-shaping pipeline. The only test in this plan that would catch a missing/broken callback is item 4 in §3 (the real, non-mocked `auth.config.ts` wiring test) — and even that test only proves the callback is *present and wired into the config object*, not that it behaves correctly against a real database row (impossible to verify without a live `DATABASE_URL`+real sign-in, which is Horace's `[human]` acceptance item). **Reviewer should specifically check `auth.config.ts`'s `callbacks.session` implementation line-by-line**, since this is exactly the kind of defect that survives a green `pnpm test` and only surfaces once Horace does the real end-to-end sign-in check.
- **Security-sensitive path: `middleware.ts`'s matcher/allowlist is the first line of defense for "no unauthenticated access to `app/(app)/**`."** Getting the allowlist wrong in either direction is a real security bug: too narrow (e.g. forgetting `/api/auth/**` exclusion) breaks the entire login flow (self-inflicted denial of service, easy to notice); too broad (e.g. accidentally adding a wildcard that swallows a real protected path, or a typo'd public path like `/sign-in` instead of `/signin`) silently exposes an authenticated-only page to anonymous users (hard to notice — no error, just wrong data exposure once real pages exist under `app/(app)/**`). This ticket's own tests (§3 item 2) cover the two known paths (`/`, `/signin`) plus a representative protected path (`/jobs`) and the `/api/auth/**` exclusion — but **cannot** cover paths that don't exist yet (every real `app/(app)/**` page is built by later modules). Flag explicitly for the Reviewer: this is a "correct by construction for what exists today, re-verify once FND-09/03-library/04-fit land real pages" situation, not a closed risk.
- **Security-sensitive path: `requireUserId()` is the sole sanctioned chokepoint (ticket's own framing, PRD §8.3) — this plan does not, and cannot, enforce that every future downstream API route actually calls it first.** Same category of standing architectural gap FND-05's plan flagged for "no cross-user query path" at the DB layer (no Postgres RLS) — this ticket's contribution is making the *correct* pattern maximally easy (one function, one import, throws loudly on misuse) but a future route handler that reads `auth()` directly and skips `requireUserId()` (bypassing the chokepoint) would not be caught by anything in this ticket's own scope. Not this ticket's job to add a lint rule or route-level enforcement mechanism (not requested, would be new scope) — noting it so the Reviewer knows the boundary of what "the one function every route imports" actually guarantees today (a good, easy-to-use API) versus what it doesn't (a compiler-enforced or lint-enforced requirement that it's always used).
- **Concurrency: `verificationTokens`' `useVerificationToken` (magic-link redemption) is a delete-then-check operation inside `@auth/drizzle-adapter`'s own adapter code (not code this ticket writes) — if the same magic-link URL is opened twice concurrently (e.g. an email client's link-prefetching/scanning bot, or a user double-clicking), the second request loses the race and Auth.js reports an expired/invalid-link error to that request.** This is inherent, pre-existing behavior of the upstream adapter this ticket wires up, not a new concurrency bug this ticket's own code introduces — flagged for the Reviewer as a known, accepted behavior (first request to redeem wins; PRD does not call out a different requirement), not something to "fix" by adding custom token-handling logic (would be new, unrequested scope, and duplicate what the adapter already does correctly for the single-request case).
- **`onDelete: 'cascade'` on `accounts.userId`/`sessions.userId` (§2.2) is this plan's own addition, matching FND-05's own precedent for the app's other user-scoped tables (`libraries`, `resumes`, `jobs`, `usage_events` all cascade on `users.id` deletion) — not explicitly required by `@auth/drizzle-adapter`'s reference schema (which defines no `onDelete` behavior at all in the upstream source quoted in §0), and not explicitly requested by this ticket's Deliverable 1 text either.** Consistent, low-risk, defense-in-depth choice (avoids orphaned session/account rows if a user row is ever deleted directly) — flagged in §5 Open Question #4 in case the Reviewer wants it reconsidered (same category of flag FND-05's plan raised for its own cascade choices).
- **Edge-runtime compatibility of the Drizzle/`neon-http` adapter call inside `middleware.ts`'s `auth()` invocation is asserted, not proven, by this plan (§0's "Edge runtime / database-session interaction" note) — this repo has no live `DATABASE_URL`/Neon instance to actually execute this code path against yet.** The mitigating facts (neon-http is fetch-based; Next.js 15.5+ has a documented, stable `runtime: 'nodejs'` opt-out) are real and cited, but the Builder cannot fully close this risk without Horace's infra hand-off (ticket Feedback obligation #2, same standing gap as every other FND ticket). If it turns out NOT to work, the fallback (§2.5's commented-out `runtime: 'nodejs'` line) is a one-line, low-risk change — flagged explicitly so a future debugging session doesn't have to rediscover this from scratch.
- **`next-auth@5.0.0-beta.31` is a prerelease.** A future beta (or eventual GA `5.0.0`) may change a mechanical detail this plan's §0 confirmed against this exact version (route handler path, export shape, provider config shape, adapter type contracts). If the Builder's actual `pnpm install` at build time resolves a *different* version than the one pinned here (e.g. because this exact version was deprecated/unpublished between planning and build — rare but not impossible for a beta channel), re-verify every fact in §0 against whatever version actually installs, and record any divergence in the ticket's own changelog per its Feedback obligation #1 — do not silently proceed on a stale assumption.
- **Windows-specific note (this plan was authored on a Windows dev machine, `win32`):** nothing in this ticket's own file set does path manipulation the way FND-05's `execFileSync`/temp-directory migration tests did — the only cross-platform-sensitive piece is the new migration-generation regression check (§2.2/§3 item 3), which should reuse FND-05's own already-Windows-safe `db/migrate.test.ts` pattern (`node:os.tmpdir()`, `node:path.join`) rather than inventing a new one.

## 5. Open questions

| # | Question | Who decides |
|---|---|---|
| 1 | Whether adding `next-auth`/`@auth/drizzle-adapter` directly to `package.json` (this plan's §0/§2.1 reading — the ticket's own File-scope section omits `package.json`, unlike FND-05's, which listed it explicitly for the same "new runtime dep" reason) is a File-scope oversight in the ticket text (this plan's assumption) or a deliberate omission requiring a different resolution (e.g. requesting a ticket amendment before proceeding). | Reviewer, at review time — low-stakes in practice (the alternative reading makes the ticket impossible to implement at all, so this plan's reading is very likely correct), but flagged per this repo's "flag interpretive calls, don't bury them" convention. |
| 2 | Whether this plan's resolution of the `signIn`-callback-vs-`signIn`-action ambiguity (§2.3 — implementing the extension point as `callbacks.signIn`, per Non-goals' literal wording, rather than attempting to "wrap" the exported `signIn` action per Deliverable 2's literal wording) matches what PLT-04's own (not-yet-written) plan will actually expect. | Reviewer now (cheap to confirm); re-confirm with PLT-04's Architect no later than that ticket's own planning pass, same escalation pattern FND-05's plan used for its own forward-looking flags. |
| 3 | `middleware.ts`'s `PUBLIC_PATHS` allowlist (§2.5) will need to grow once `07-platform-launch` adds `app/(legal)/**` pages — but `breakdown-plan.md`'s global file-ownership table grants no module explicit append rights to `middleware.ts` for this purpose (only `auth.ts`'s `signIn` callback is named as PLT-04-appendable). Who is authorized to edit `middleware.ts` when that ticket is planned, and under what "append, don't restructure" discipline? | Horace / whichever Architect plans `07-platform-launch`'s tickets — not blocking for FND-08, but flagged now so it isn't rediscovered as a surprise mid-build later (same category as FND-05's forward-looking flags for PLT-01). |
| 4 | Whether `accounts.userId`/`sessions.userId`'s `onDelete: 'cascade'` (this plan's default, §2.2/§4, matching FND-05's precedent for the app's other tables) is wanted, given `@auth/drizzle-adapter`'s own upstream reference schema defines no cascade behavior at all. | Reviewer now (cheap to flip before any real data exists) — same pattern as FND-05's plan's Open Question #2. |
| 5 | Whether the Edge-runtime `auth()` call inside `middleware.ts` actually works against `neon-http` in practice (§4), or needs `runtime: 'nodejs'` from day one rather than as a documented fallback. | Cannot be resolved by the Builder without a live `DATABASE_URL` + real OAuth credentials (Horace's infra hand-off, ticket Feedback obligation #2) — genuinely open until Horace's `[human]` acceptance item runs; this plan's default (no `runtime: 'nodejs'`, commented-out fallback ready) is a reasonable bet given the fetch-based driver, not a guarantee. |

## 6. ADR-candidate flag

**Not proposing a new ADR file now — the ticket is explicit that none is needed** for the core "Auth.js v5, Google OAuth + Resend magic link, Drizzle adapter, database session strategy" decision (already made in PRD §8.1/§8.3). This plan implements exactly what the ticket specifies.

One sub-decision inside this plan is worth a future ADR pass's awareness, though this plan does not think it rises to "needs its own ADR file today":

- **Keeping a single, unsplit `auth.config.ts`/`auth.ts` (adapter included) used by both server-side code and `middleware.ts`, rather than Auth.js's own officially-documented "Split Config" pattern (separate adapter-less, JWT-strategy instance for Middleware/Proxy) — §0/§4.** This is a considered deviation from the framework's own documented best practice, justified specifically by this stack's `neon-http` fetch-based driver being Edge-compatible (unlike the TCP-based adapters the official guide is mainly warning about). If that justification ever turns out to be wrong in practice (§4/§5 Open Question #5), the fix is either the low-cost `runtime: 'nodejs'` middleware opt-out (contained, one file) or, if that also proves insufficient, actually adopting the Split Config pattern (a larger, cross-cutting change touching `auth.config.ts`'s shape and every place that currently assumes one unified `auth()` — exactly the kind of "hard to reverse once feature modules exist" property that would justify writing this up as ADR-0002+ at that point, not now). Recorded here as a named pointer so a future debugging session that hits an Edge-runtime Auth.js error doesn't have to rediscover this trade-off from scratch — see also the ticket's own Feedback obligation #3, which already reserves the right to revisit the `database` vs `jwt` session-strategy choice itself as a "post-P0 performance question," a closely related but distinct decision this same pointer should be read alongside.
