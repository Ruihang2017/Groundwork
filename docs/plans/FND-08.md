# Implementation plan — FND-08: Auth.js v5 (Google OAuth + magic link) and session/userId scoping helper

Ticket: [docs/prd/01-foundation/tickets/FND-08-authjs-session.md](../prd/01-foundation/tickets/FND-08-authjs-session.md)
Sub-PRD: [docs/prd/01-foundation/README.md](../prd/01-foundation/README.md) (v0.5)
Master spec: [docs/PRD.md](../PRD.md) §8.1 (stack pin: "Auth.js v5（Google OAuth + email magic link via Resend）… 选 Auth.js 而非 Clerk"), §8.3 ("数据隔离：全部查询以 session userId 约束，无跨用户查询路径"), §10 P0 ("注册/登录可用，空应用在线")
Breakdown plan file-ownership: [docs/prd/breakdown-plan.md](../prd/breakdown-plan.md) §3 (`auth.ts`, `auth.config.ts`, `middleware.ts`, `lib/auth/session.ts`, `app/api/auth/**` → `01-foundation`/FND-08 creates; `07-platform-launch`/PLT-04 appends invite-code validation into the `signIn` callback only).
Depends on (merged into `main`): FND-05 (`db/schema.ts` eight tables incl. `users`; `db/index.ts` — throws at import time if `DATABASE_URL` unset).
Downstream: FND-09 (imports `auth`/`signIn`/`signOut` from `@/auth`, and its own acceptance item literally requires "middleware.ts (FND-08) correctly redirects an unauthenticated request … to `/signin`"); every feature module (LIB-01, FIT-01, PLT-01, PLT-03, PLT-04, …) imports `requireUserId()` from `lib/auth/session.ts` as the only sanctioned way to get a trustworthy `userId`; PLT-04 wraps/replaces this plan's `signInCallback`.

ADR status: none needed — PRD §8.1/§8.3 already make the "Auth.js v5, Google + Resend, Drizzle adapter, database session strategy" decision; the ticket says so explicitly. One sub-decision inside this plan (§6) is flagged as an ADR-candidate for future awareness, not a new ADR today.

## 0. Repo-state check performed for this plan (verified by direct inspection 2026-07-18, do not re-derive)

**Important note for whoever reads this plan next.** The working tree on `ticket/FND-08` (2 commits ahead of `main`: `b38bac8` "commit Architect implementation plan", `3f93cd9` "Auth.js v5 (Google OAuth + Resend magic link) + session/userId scoping") **already contains a full implementation of this ticket**, and the ticket file itself already carries a Builder Changelog (v0.1) describing it, mirrored in `01-foundation/README.md` v0.5. This plan was authored/re-verified against that actual, current repository state — every file and code excerpt in §2 below was read directly from disk on this branch, not reconstructed from the ticket text or guessed. Where the prose below states a fact as confirmed, it means "confirmed by reading the real file," not "predicted from documentation." This plan is written to remain useful as the canonical design reference for the Reviewer stage and for any future maintenance of this ticket's files — a fresh agent with no access to this conversation can use it to understand, validate, or reproduce the implementation from the ticket alone.

Verified facts:

- `git diff --stat main..HEAD` shows exactly: `app/api/auth/[...nextauth]/route.ts`, `auth.config.ts`, `auth.ts`, `middleware.ts`, `lib/auth/session.ts`, `db/schema.ts` (append), `db/migrations/0001_first_spiral.sql` + its `meta/` snapshot/journal, four new test files (`auth.config.test.ts`, `middleware.test.ts`, `lib/auth/session.test.ts`, `db/schema-auth.test.ts`), `package.json`, `pnpm-lock.yaml`, `vitest.config.ts`, `docs/plans/FND-08.md` (this file), `docs/prd/01-foundation/README.md`, `docs/prd/01-foundation/tickets/FND-08-authjs-session.md`. Nothing outside this ticket's file-scope is touched — no edit inside `app/(auth)/**`, `app/(app)/**`, `lib/db/queries/**`, or any of `db/schema.ts`'s eight pre-existing tables.
- `db/schema.ts`'s eight FND-05 tables (`users`, `libraries`, `resumes`, `jobs`, `tailoredResumes`, `briefs`, `usageEvents`, `evalRuns`) are unchanged byte-for-byte except the file's top-of-file convention comment (point 1), which now names `sessions.expires`/`verificationTokens.expires` alongside `users.emailVerified` as the native-`timestamp` exception, and the import list, which gained `primaryKey`. `db/schema.test.ts` (FND-05's own file) is untouched.
- `package.json` `dependencies` gained exactly two lines: `"@auth/drizzle-adapter": "1.11.2"` and `"next-auth": "5.0.0-beta.31"` (exact pins, no floating `@beta`/`@latest` tag). No `nodemailer`/`@simplewebauthn/*` added (all three are `next-auth`'s optional peers, unused by the Google/Resend-only provider set).
- `.env.example` unchanged — already lists `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL` (added by FND-01).
- `vitest.config.ts`'s `test.include` gained a fourth entry, `'*.test.ts'`, next to the pre-existing `'tests/**/*.test.ts'`, `'lib/**/*.test.ts'`, `'db/**/*.test.ts'` — needed because `middleware.test.ts`/`auth.config.test.ts` are colocated at the repo root (matching this repo's dominant colocation convention), which none of the three original globs reach.
- Route-handler convention: `app/api/auth/[...nextauth]/route.ts` re-exporting `{ GET, POST } = handlers` — matches Auth.js v5's own documented convention for the installed version exactly; no divergence.
- `NextAuth()`'s export shape `{ handlers, auth, signIn, signOut }` is unchanged from the framework's documented shape.
- The single most important, non-obvious fact this plan documents: **under `session: { strategy: 'database' }`, Auth.js's `Session.user` has no `id` field by default.** `auth.config.ts`'s `callbacks.session({ session, user }) { session.user.id = user.id; return session; }` is what populates it — `user` here is the full `AdapterUser` row the adapter fetched from the DB, only available under the database session strategy. **Without this callback, `requireUserId()` would compile and its mocked unit tests would pass, but every real, non-mocked signed-in user would get `session.user.id === undefined`, making `requireUserId()` throw `UnauthorizedError` unconditionally** — a production-breaking bug invisible to a test suite that only mocks `auth()`. This is implemented (§2.1) and is the one thing in this ticket's whole surface a Reviewer should read line-by-line rather than skim (§4).
- Edge-runtime / database-session interaction: Auth.js's own official guidance for Middleware + a database session strategy is a separate, adapter-less "Split Config" (documented at `authjs.dev/guides/edge-compatibility`). **This implementation deliberately does not use that split** — one `auth.config.ts` (adapter included) backs both server code and `middleware.ts`. This is justified because FND-05's `db/index.ts` uses `drizzle-orm/neon-http` + `@neondatabase/serverless`, an HTTP-`fetch`-based, Edge-compatible driver — the specific concern the official guide is warning about (TCP-socket-based adapters) does not apply to this stack. `pnpm build` succeeds (exit 0) with this design; see §4 for the one caveat this claim still carries (no live `DATABASE_URL` to fully prove it end-to-end).
- Route groups (`app/(app)/**`, `app/(auth)/**`, `app/(legal)/**`) are invisible in the actual request URL. "Protect `app/(app)/** ` routes" (ticket Deliverable 4) is therefore implemented as an explicit **public-path allowlist** (`PUBLIC_PATHS`) rather than a literal path-prefix matcher — `middleware.ts`'s allowlist currently holds exactly `/` (landing page) and `/signin` (FND-09's not-yet-built sign-in page — its own ticket text confirms this is the real, literal target URL).
- No `docs/adr/` directory exists in this repo yet (`docs/adr/*.md` glob returns no files) — nothing there touches this ticket's area.

## 1. Scope

**In scope** (matches the ticket's Goal/Deliverables — all five are implemented; restated here for a single at-a-glance list, ticket file remains the source of truth for exact wording):

- `auth.config.ts` (repo root) — full `NextAuthConfig`: Google + Resend providers, `DrizzleAdapter` bound to `db` + `accounts`/`sessions`/`verificationTokens`/`users`, `session: { strategy: 'database' }`, a named+exported `signInCallback` (allow-all, PLT-04's future extension point), a `session` callback wiring `session.user.id = user.id`.
- `auth.ts` (repo root) — `export const { handlers, auth, signIn, signOut } = NextAuth(authConfig)` plus the `declare module 'next-auth'` `Session.user.id` TypeScript augmentation.
- `app/api/auth/[...nextauth]/route.ts` — `export const { GET, POST } = handlers`.
- `middleware.ts` (repo root) — protects every page route except `/` and `/signin`; redirects unauthenticated requests to `/signin`; matcher excludes `/api/**` and Next.js internals.
- `lib/auth/session.ts` — `UnauthorizedError` class + `requireUserId(): Promise<string>`, the sole chokepoint every downstream API route must call for a trustworthy `userId`.
- `db/schema.ts` (append) — `accounts`, `sessions`, `verificationTokens` tables, `primaryKey` import, one comment-block update; zero changes to the eight existing tables.
- `db/migrations/0001_first_spiral.sql` (+ `meta/` snapshot/journal) — generated via `pnpm db:generate`, never hand-authored; diff-only, touches only the three new tables.
- `package.json` (append) — `next-auth`, `@auth/drizzle-adapter` runtime dependencies; `pnpm-lock.yaml` regenerated as a side effect.
- `vitest.config.ts` (append) — widen `test.include` with `'*.test.ts'` so the two root-colocated test files are discovered.
- Four new test files: `db/schema-auth.test.ts`, `lib/auth/session.test.ts`, `middleware.test.ts` (root), `auth.config.test.ts` (root).
- `docs/prd/01-foundation/README.md` — changelog v0.4 → v0.5.
- `docs/prd/01-foundation/tickets/FND-08-authjs-session.md` — Changelog v0.1 (build-time decisions/deviations).

**Explicitly out of scope** (per ticket Non-goals — confirmed not implemented, checked against the actual diff in §0):

- No invite-code validation logic inside `signInCallback` — it is a trivial `return true`, named and exported so PLT-04 can wrap it later.
- No `app/(auth)/signin/page.tsx` — FND-09's file; this ticket's exports are what that (not-yet-existing) page will call into.
- No `lib/db/queries/**` files of any kind.
- No admin-role column or claim on `users`.
- No account-deletion logic.
- No real Google OAuth client registration, no real Resend account/domain verification, no live end-to-end sign-in test — every test in this ticket's suite mocks `auth()`/the adapter/providers, or uses an offline PGlite instance; no live Neon/Google/Resend credentials anywhere. The `[human]` acceptance item (Horace provisioning real credentials and confirming sign-in on a deployed preview) is not satisfiable by this plan or by any agent.
- No `app/(legal)/**` allowlisting in `middleware.ts` — those pages don't exist yet (`07-platform-launch` creates them); §5 Open Question #3 covers who extends the allowlist later.

## 2. Change list

Every excerpt below is the verified, current content of the file on `ticket/FND-08` (read directly, 2026-07-18) — not a proposal.

### 2.1 `auth.config.ts` (new, repo root)

```ts
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
// invite-code check: always allow. See docs/plans/FND-08.md §2.3 for the
// signIn-callback (this) vs. signIn-action (exported from auth.ts) disambiguation.
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
    // REQUIRED for database-strategy sessions: Session.user has no `id` field by
    // default. Without this callback, requireUserId() (lib/auth/session.ts) would
    // always throw UnauthorizedError in real (non-mocked) usage even for a
    // genuinely signed-in user, because session.user.id would be undefined. The
    // `user` arg here is the full AdapterUser row the adapter fetched from the DB
    // (only available under the database session strategy). See FND-08 plan §0.
    session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;

export default authConfig;
```

Notes:
- `AUTH_SECRET` needs no explicit code — Auth.js v5 reads `process.env.AUTH_SECRET` automatically.
- `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET`/`RESEND_API_KEY`/`RESEND_FROM_EMAIL` are read explicitly (not via Auth.js's bare `providers: [Google]` auto-inference form) — matches the ticket's own literal `Google({...})`/`Resend({...})` Deliverable-1 text.
- **Resolution of a real ambiguity between the ticket's Deliverable 2 and its Background/Non-goals.** Deliverable 2 says "`signIn` is exported as a named, wrapped function… specifically so PLT-04 has one clean extension point" but Background/Non-goals both say "PLT-04 appends an invite-code check into this ticket's `signIn` **callback**." Auth.js has two different things colloquially called "signIn": (a) `callbacks.signIn(params)` — the gate deciding whether a sign-in attempt is allowed, where invite-code validation actually belongs; (b) the `signIn(...)` *action* exported from `NextAuth()` that a client component calls to initiate a flow (`signIn('google')`) — unrelated to gating. This implementation treats Non-goals as authoritative and implements (a) as `signInCallback`; the exported `{ signIn }` action in `auth.ts` (§2.2) is produced automatically by the standard destructure and needs no extra wrapping. Both readings end up satisfied; flagged for the Reviewer (§5 Q2).

### 2.2 `auth.ts` (new, repo root)

```ts
import NextAuth, { type DefaultSession } from 'next-auth';

import authConfig from '@/auth.config';

// Make `session.user.id` type-check anywhere in the app. Auth.js's default
// Session.user has no `id` field; auth.config.ts's `session` callback populates it
// at runtime under the database session strategy — this augmentation is the
// compile-time half of that same wiring.
declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
    } & DefaultSession['user'];
  }
}

// Standard Auth.js v5 export shape. `signIn`/`signOut` here are the client/server
// ACTIONS that initiate/terminate a sign-in flow (e.g. signIn('google')) — a
// different thing from auth.config.ts's `signInCallback` (the gate that decides
// whether an attempt is allowed, PLT-04's future invite-code extension point).
export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
```

`@/auth.config` resolves via `tsconfig.json`'s existing `@/*` → repo-root path alias (already exercised by every other module's `@/db/schema`-style import) — confirmed working (the build/test suite both resolve it; see §3).

### 2.3 `app/api/auth/[...nextauth]/route.ts` (new)

```ts
import { handlers } from '@/auth';

// Auth.js v5's route-handler convention (confirmed against the installed
// next-auth@5.0.0-beta.31 / authjs.dev next.js installation docs): re-export the
// framework-generated GET/POST handlers. This endpoint MUST stay reachable
// unauthenticated — middleware.ts's matcher excludes /api/** for exactly this.
export const { GET, POST } = handlers;
```

### 2.4 `middleware.ts` (new, repo root)

```ts
import { NextResponse } from 'next/server';

import { auth } from '@/auth';

// Route groups (app/(app)/**, app/(auth)/**, app/(legal)/**) are invisible in the
// actual request URL — "protect app/(app)/** routes" (ticket Deliverable 4) is
// therefore implemented as "protect every page route EXCEPT this explicit
// allowlist," not as a literal `/(app)/...` path matcher (which would never match
// any real request — see FND-08 plan §0). Extend this SET, not the matcher below,
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
  // requireUserId() — see lib/auth/session.ts — and /api/auth/** specifically MUST
  // stay reachable unauthenticated or the OAuth/magic-link flow itself breaks) and
  // Next.js's own static/image/favicon internals. Mirrors Auth.js's own official
  // example matcher.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
  // If empirical testing (once Horace provisions real DATABASE_URL/OAuth
  // credentials — this repo has neither yet) shows the Edge runtime rejects the
  // Drizzle/neon-http adapter call inside auth() above, uncomment:
  // runtime: 'nodejs', // stable since Next.js 15.5 (this repo pins ^15.5.20)
};
```

**Critical correctness note, not optional:** if `/api/**` (or at minimum `/api/auth/**`) is ever accidentally included in the protected set, the sign-in flow itself breaks (OAuth callback / magic-link verification endpoints get redirected to `/signin` before they can complete) — a redirect loop or broken login for every user. Covered by a dedicated regression test (§3, `middleware.test.ts`).

### 2.5 `lib/auth/session.ts` (new)

```ts
import { auth } from '@/auth';

/**
 * Thrown by `requireUserId()` when there is no valid session. Every downstream API
 * route is expected to catch this by `instanceof` and convert it to an HTTP 401:
 *
 *   catch (e) {
 *     if (e instanceof UnauthorizedError) {
 *       return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
 *     }
 *     throw e;
 *   }
 *
 * It is exported precisely so that pattern type-checks and matches by `instanceof`,
 * not by string-matching an error message.
 */
export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * The ONE chokepoint every downstream API route (every module: LIB, FIT, TLR, PRP,
 * PLT) must call first to get a trustworthy `userId` for query scoping (PRD §8.3's
 * "全部查询以 session userId 约束" mandate). Never returns undefined/empty silently
 * — always throws `UnauthorizedError` instead, so a route that forgets to handle
 * the error surfaces as a loud 500 rather than a silent cross-user query bug.
 */
export async function requireUserId(): Promise<string> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    throw new UnauthorizedError();
  }
  return userId;
}
```

### 2.6 `db/schema.ts` — append (no edits to any existing table)

`primaryKey` added to the `drizzle-orm/pg-core` import list (alphabetically, per the file's existing convention). Appended after `eval_runs`, preceded by a section comment matching the file's house style:

```ts
export const accounts = pgTable(
  'accounts',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type')
      .$type<'oauth' | 'oidc' | 'email' | 'webauthn'>()
      .notNull(),
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

Confirmed load-bearing, non-obvious fact: the property names `refresh_token`/`access_token`/`expires_at`/`token_type`/`id_token`/`session_state` on `accounts` are themselves snake_case JS object keys (mirroring OAuth2's own wire-format field names) — `@auth/drizzle-adapter`'s `DefaultPostgresAccountsTable` type requires exactly these keys; renaming them to camelCase fails to compile at the `DrizzleAdapter(db, { accountsTable: accounts, … })` call site. `users` needed zero changes — its existing shape (`id`/`name`/`email`/`emailVerified`/`image`) already satisfies the adapter's `DefaultPostgresUsersTable` contract.

`onDelete: 'cascade'` on `accounts.userId`/`sessions.userId` is not present in `@auth/drizzle-adapter`'s own upstream reference schema (which defines no cascade behavior) — added here to match FND-05's precedent for this app's other user-scoped tables (`libraries`, `resumes`, `jobs`, `usage_events` all cascade on `users.id`). Behaviorally tested (§3). Flagged for the Reviewer (§5 Q4) as a plan-level addition, not an upstream requirement.

### 2.7 `db/migrations/0001_first_spiral.sql` (+ `meta/0001_snapshot.json`, `meta/_journal.json` update)

Generated via `pnpm db:generate` (never hand-authored), per FND-05's established "every schema change → new migration" discipline. drizzle-kit emitted a diff-only migration touching only the three new tables — the eight existing tables' original migration/SQL are untouched. Contains `CREATE TABLE "accounts"`, `"sessions"`, `"verification_tokens"`, the composite `PRIMARY KEY("provider","provider_account_id")` / `PRIMARY KEY("identifier","token")`, and the `ON DELETE cascade` foreign keys — all independently re-verified by `db/schema-auth.test.ts`'s SQL-content assertions (§3).

### 2.8 `package.json` / `pnpm-lock.yaml`

```diff
   "dependencies": {
+    "@auth/drizzle-adapter": "1.11.2",
     "@neondatabase/serverless": "^1.1.0",
     "drizzle-orm": "^0.45.2",
     "next": "^15.5.20",
+    "next-auth": "5.0.0-beta.31",
     "react": "^19.2.7",
```

Both exact-pinned (no floating `@beta`/`@latest`) — chosen because `next-auth`'s `latest` npm dist-tag is still v4 (`4.24.14`); v5 exists only under the `beta` dist-tag. `@auth/drizzle-adapter@1.11.2` and `next-auth@5.0.0-beta.31` both resolve `@auth/core` to the same `0.41.2` — confirmed compatible pairing. `pnpm-lock.yaml` regenerated as a side effect of `pnpm install`, not hand-edited. `package.json` was not listed in the ticket's own File-scope section — read as an oversight (FND-05's ticket listed `package.json` explicitly for the identical "new runtime dep" reason, and `01-foundation` already owns the file) rather than a prohibition; flagged for the Reviewer (§5 Q1).

### 2.9 `vitest.config.ts`

```diff
-    include: ['tests/**/*.test.ts', 'lib/**/*.test.ts', 'db/**/*.test.ts'],
+    include: [
+      'tests/**/*.test.ts',
+      'lib/**/*.test.ts',
+      'db/**/*.test.ts',
+      '*.test.ts',
+    ],
```

Needed because `middleware.test.ts`/`auth.config.test.ts` are colocated at the repo root, and none of the three pre-existing globs reach a root-level file — the same "false green, 0 assertions actually run" failure mode FND-02/FND-05 each fixed for their own new test locations (`01-foundation/README.md` v0.3/v0.4). Verifying this actually works (not just that `pnpm test` exits 0) is mandatory — see §3.

### 2.10 Ticket + sub-PRD writebacks

`docs/prd/01-foundation/tickets/FND-08-authjs-session.md` — Changelog v0.1 (build-time decisions/deviations, quoted throughout this plan). `docs/prd/01-foundation/README.md` — Changelog v0.4 → v0.5, one paragraph summarizing the same points for module-level visibility.

## 3. Test plan

Maps to the ticket's acceptance checklist; every test is fully offline (no live Neon, no real Google/Resend credentials — per ticket Feedback obligation #2).

1. **`lib/auth/session.test.ts` — acceptance items 1–2.** Mocks the whole `@/auth` module (`vi.mock('@/auth', () => ({ auth: vi.fn() }))`, hoisted before the import) — required, not stylistic, because `@/auth` transitively imports `@/auth.config` → `@/db/index`, and `db/index.ts` throws at import time if `DATABASE_URL` is unset. Covers: `auth()` resolves `null` → `requireUserId()` rejects with `UnauthorizedError`; valid `{ user: { id: 'user-123' } }` → resolves `'user-123'`; session present but `user.id` missing/absent → still rejects (never silently resolves `undefined`); the rejected error is a real `UnauthorizedError` catchable by `instanceof` with `.name === 'UnauthorizedError'`.
2. **`middleware.test.ts` (root) — acceptance item 3.** Mocks `@/auth` as a pass-through higher-order function so the test can capture and directly invoke the inner request handler. Covers: the exported `config.matcher` is a single-entry array that excludes `/api/**` (including `/api/auth/session`, `/api/auth/callback/google` — the critical correctness guard from §2.4) and Next.js's static/image/favicon internals, matches representative protected paths (`/jobs`, `/library`), and contains no literal route-group segment (`(app)`/`(auth)`/`(legal)`); an unauthenticated request to a protected path (`/jobs`) redirects to `/signin`; an authenticated request to the same path passes through; `/` and `/signin` pass through unauthenticated with no redirect.
3. **`db/schema-auth.test.ts` — acceptance item 4 + the ticket's own schema-append regression requirement.** Does **not** modify `db/schema.test.ts` (left byte-for-byte unmodified per FND-05's own design intent, confirmed in §0). Pure Drizzle introspection (`getTableName`/`getTableColumns`/`getTableConfig`) plus a real **PGlite round-trip** (same `drizzle-orm/pglite` driver/migrator the production path's migration convention uses): asserts each new table's exact column-key set (including the load-bearing `refresh_token`/`access_token`/… property names on `accounts`), the composite primary keys `(provider, providerAccountId)` and `(identifier, token)`, `sessions`'s single-column `sessionToken` primary key, `sessions.expires`/`verificationTokens.expires` are native `timestamp` (not `bigint`) while `accounts.expires_at` is `integer` (unix seconds, not epoch-ms), NOT NULL constraints on required columns, that the generated migration SQL contains the three `CREATE TABLE` statements plus the `ON DELETE cascade` foreign keys and composite `PRIMARY KEY` declarations, and a full insert-then-select round-trip through a real (in-memory, WASM) Postgres proving the migration actually applies — plus a dedicated cascade test: deleting a `users` row removes the dependent `accounts`/`sessions` rows.
4. **`auth.config.test.ts` (root) — Deliverable 1's literal shape, and the single highest-risk item's own test.** The one test file in the whole suite that imports the **real** (non-mocked) `@/auth.config` — sets a syntactically valid dummy `DATABASE_URL` (`vi.stubEnv`) before import, since `neon()`/`drizzle()` construction is lazy/network-free (same proven pattern as `db/index.test.ts`). Asserts: exactly two providers, ids `'google'` and `'resend'`; `session.strategy === 'database'`; `adapter` is defined; `signInCallback` is exported, is a function, resolves `true`, and is the exact same function reference wired into `callbacks.signIn`; and — the test that actually guards §0's top risk — calling `callbacks.session` directly with a fabricated `{ session: { user: {...} }, user: { id: 'db-user-1' } }` input copies `user.id` onto `session.user.id`. This is the only test that would fail if the `session` callback were ever removed or broken; every `requireUserId()` test mocks `auth()` directly and would stay green regardless.
5. **`pnpm test` green — the standing acceptance item.** Confirmed by directly reading all four new test files' full contents; the ticket's own Changelog additionally states the runner's own output listing was inspected (not just exit code) to confirm the two root-level files were actually discovered post-§2.9's glob widening. This plan's own environment has no `pnpm` on `PATH` to re-run the suite live; the file-level verification above (every assertion read directly from disk, cross-checked against the actual `auth.config.ts`/`middleware.ts`/`lib/auth/session.ts`/`db/schema.ts` implementations) is the basis for treating this as satisfied — the Reviewer stage should re-run `pnpm test` itself as an independent confirmation, per its own mandate to re-run the full suite.
6. **`pnpm build`** — per the ticket's own Changelog, succeeds (exit 0; `/api/auth/[...nextauth]` and Middleware both compile), with a non-fatal Edge-Runtime warning about `jose`'s `CompressionStream`/`DecompressionStream` (JWE code path, not exercised under the database session strategy this ticket uses) — see §4.
7. `git diff --stat main..HEAD` matches exactly the file list in §0/§1 — independently confirmed in this planning pass; nothing outside file-scope is touched.

## 4. Risks & edge cases

- **Mock-passes-but-real-breaks risk (highest priority in this ticket): the `callbacks.session` `session.user.id = user.id` wiring (§2.1) is required for `requireUserId()` to work at all against a real session, and nothing in the ticket's own literal Deliverable/acceptance text names this requirement.** Every `requireUserId()` test mocks `auth()` directly with a hand-fabricated `{ user: { id: '...' } }` object, so such tests pass green even if the `session` callback were missing entirely. The only test that would catch a missing/broken callback is `auth.config.test.ts`'s direct, non-mocked invocation of the real callback (§3 item 4) — and even that only proves the callback is present, wired, and behaves correctly against a *fabricated* `AdapterUser`-shaped input, not that it behaves correctly against a real database row (impossible to verify without a live `DATABASE_URL` + real sign-in, which is Horace's `[human]` acceptance item). **Reviewer should read `auth.config.ts`'s `callbacks.session` line-by-line** — this is exactly the kind of defect that survives a green `pnpm test` and only surfaces once Horace does the real end-to-end sign-in check.
- **Security-sensitive path: `middleware.ts`'s `PUBLIC_PATHS` allowlist is the first line of defense for "no unauthenticated access to `app/(app)/**`."** Too narrow (e.g. forgetting the `/api/auth/**` exclusion) breaks the entire login flow — self-inflicted, easy to notice. Too broad (e.g. a typo'd public path, or a future edit that widens the allowlist carelessly) silently exposes an authenticated-only page to anonymous users — hard to notice, no error, just wrong data exposure once real pages exist under `app/(app)/**`. This ticket's own tests (§3 item 2) cover the two known public paths plus a representative protected path and the `/api/auth/**` exclusion, but **cannot** cover paths that don't exist yet (every real `app/(app)/**` page is built by later modules). Flag for the Reviewer: correct by construction for what exists today, needs re-verification once FND-09/03-library/04-fit land real pages.
- **Security-sensitive path: `requireUserId()` is the sole sanctioned chokepoint (PRD §8.3's own framing) — nothing in this ticket enforces that every future downstream API route actually calls it first.** Same category of standing architectural gap FND-05's plan flagged for "no cross-user query path" at the DB layer (no Postgres RLS). This ticket makes the *correct* pattern maximally easy (one function, one import, throws loudly on misuse) but cannot prevent a future route from reading `auth()` directly and skipping the chokepoint. Not this ticket's job to add lint/route-level enforcement — noting the boundary for the Reviewer.
- **Concurrency: magic-link redemption (`verificationTokens`) is a delete-then-check operation inside `@auth/drizzle-adapter`'s own code (not code this ticket writes).** If the same magic-link URL is opened twice concurrently (e.g. an email client's link-prefetching bot, or a double-click), the second request loses the race and Auth.js reports an expired/invalid-link error to it. This is inherent, pre-existing upstream-adapter behavior, not a new bug this ticket introduces — flagged as known/accepted (first request to redeem wins; PRD does not require different behavior), not something to "fix" with custom token-handling logic.
- **`onDelete: 'cascade'` on `accounts.userId`/`sessions.userId` is this implementation's own addition** (matching FND-05's precedent for the app's other user-scoped tables), not present in `@auth/drizzle-adapter`'s upstream reference schema. Low-risk, defense-in-depth (avoids orphaned session/account rows on user deletion), behaviorally tested — flagged in §5 Q4 in case the Reviewer wants it reconsidered.
- **Edge-runtime compatibility of the Drizzle/`neon-http` adapter call inside `middleware.ts`'s `auth()` invocation is asserted by citation + a successful `pnpm build`, not proven end-to-end** — this repo has no live `DATABASE_URL`/Neon instance to actually execute this code path against with real traffic yet. `pnpm build`'s own Edge-Runtime warning (about `jose`'s `CompressionStream`/`DecompressionStream`, the unused JWE path) is not fatal, but it is a signal worth re-checking once real credentials exist. The mitigating fallback (`runtime: 'nodejs'`, commented in `middleware.ts`, stable since Next.js 15.5) is a one-line change if empirical testing surfaces an actual incompatibility — flagged so a future debugging session doesn't have to rediscover this from scratch.
- **`next-auth@5.0.0-beta.31` is a prerelease.** A future beta or eventual GA `5.0.0` may change a mechanical detail this plan confirmed against this exact version (route handler path, export shape, provider config shape, adapter type contracts). If a later `pnpm install` on this branch (or a rebase) resolves a different version, re-verify every fact in §0 against whatever version actually installs and record any divergence in the ticket's own changelog.
- **Windows-specific note** (this plan authored on `win32`): the only path-sensitive test code is `db/schema-auth.test.ts`'s migration-directory read (`node:path.join(process.cwd(), 'db', 'migrations')`) — cross-platform-safe, matches FND-05's own already-Windows-safe `db/migrate.test.ts` pattern.

## 5. Open questions

| # | Question | Who decides |
|---|---|---|
| 1 | Whether adding `next-auth`/`@auth/drizzle-adapter` directly to `package.json` (§2.8 — the ticket's own File-scope section omits `package.json`, unlike FND-05's, which listed it explicitly for the same "new runtime dep" reason) was a File-scope oversight in the ticket text (this plan's reading, and the reading the implementation used) or a deliberate omission that should have blocked the build pending a ticket amendment. | Reviewer, at review time — low-stakes in practice (the alternative reading makes the ticket unimplementable), but flagged per this repo's "flag interpretive calls, don't bury them" convention. |
| 2 | Whether this plan's resolution of the `signIn`-callback-vs-`signIn`-action ambiguity (§2.1 — implementing the extension point as `callbacks.signIn` per Non-goals' literal wording, rather than "wrapping" the exported `signIn` action per Deliverable 2's literal wording) matches what PLT-04's own (not-yet-written) plan will actually expect. | Reviewer now (cheap to confirm); re-confirm with PLT-04's Architect no later than that ticket's own planning pass. |
| 3 | `middleware.ts`'s `PUBLIC_PATHS` allowlist (§2.4) will need to grow once `07-platform-launch` adds `app/(legal)/**` pages — but `breakdown-plan.md`'s file-ownership table grants no module explicit append rights to `middleware.ts` for this purpose (only `auth.config.ts`'s `signIn` callback is named as PLT-04-appendable). Who is authorized to edit `middleware.ts` when that ticket is planned, and under what "append, don't restructure" discipline? | Horace / whichever Architect plans `07-platform-launch`'s tickets — not blocking for FND-08, flagged now so it isn't rediscovered as a surprise mid-build later. |
| 4 | Whether `accounts.userId`/`sessions.userId`'s `onDelete: 'cascade'` (this implementation's default, §2.6/§4, matching FND-05's precedent) is wanted, given `@auth/drizzle-adapter`'s own upstream reference schema defines no cascade behavior at all. | Reviewer now (cheap to flip before any real data exists). |
| 5 | Whether the Edge-runtime `auth()` call inside `middleware.ts` actually works against `neon-http` in practice, or needs `runtime: 'nodejs'` from day one rather than as a documented fallback. | Cannot be resolved without a live `DATABASE_URL` + real OAuth credentials (Horace's infra hand-off, ticket Feedback obligation #2) — genuinely open until Horace's `[human]` acceptance item runs. |

## 6. ADR-candidate flag

Not proposing a new ADR file — the ticket is explicit that none is needed for the core "Auth.js v5, Google OAuth + Resend magic link, Drizzle adapter, database session strategy" decision (already made in PRD §8.1/§8.3), and this implementation matches exactly what the ticket specifies.

One sub-decision inside this plan is worth a future ADR pass's awareness, though it does not rise to "needs its own ADR file today":

- **Keeping a single, unsplit `auth.config.ts`/`auth.ts` (adapter included) used by both server-side code and `middleware.ts`, rather than Auth.js's own officially-documented "Split Config" pattern (§0/§4).** A considered deviation from the framework's documented best practice, justified specifically by this stack's `neon-http` fetch-based driver being Edge-compatible (unlike the TCP-based adapters the official guide mainly warns about). If that justification turns out wrong in practice (§4/§5 Q5), the fix is either the low-cost `runtime: 'nodejs'` middleware opt-out (contained, one file) or, if that's insufficient, adopting the Split Config pattern (a larger, cross-cutting change touching `auth.config.ts`'s shape and every place assuming one unified `auth()`) — exactly the kind of "hard to reverse once feature modules exist" property that would justify an ADR at that point, not now. Recorded here so a future debugging session that hits an Edge-runtime Auth.js error doesn't have to rediscover this trade-off from scratch — read alongside the ticket's own Feedback obligation #3, which separately reserves the right to revisit the `database` vs `jwt` session-strategy choice itself as a post-P0 performance question.
