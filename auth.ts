import { DrizzleAdapter } from '@auth/drizzle-adapter';
import NextAuth, {
  type DefaultSession,
  type NextAuthConfig,
} from 'next-auth';

import authConfig, { signInCallback } from '@/auth.config';
import { accounts, sessions, users, verificationTokens } from '@/db/schema';

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

// Lazy config initialization (Auth.js v5's documented `NextAuth(async () => …)`
// form — confirmed against next-auth@5.0.0-beta.31: the factory is invoked
// per-request via `await config(req)`, NEVER at module-eval time). This is the
// FND-08 Reviewer bounce fix for finding #1 (clean-checkout `pnpm build` blocker):
// importing this module — which `next build` does during "Collecting page data"
// for both the app/api/auth/[...nextauth] route and middleware.ts — must NOT pull
// `@/db/index` into the static graph, because db/index.ts throws at import time
// when DATABASE_URL is unset (an intentional FND-05 fail-fast enforced by
// db/index.test.ts). Deferring the `db` import into this request-time factory keeps
// the build DB-free (so `pnpm build` succeeds on a checkout with no DATABASE_URL,
// including CI) while preserving FND-05's runtime fail-fast unchanged. Exported so
// auth.test.ts can assert the adapter wiring directly. `@/db/schema` is imported
// statically above because schema.ts requires no DATABASE_URL (it defines table
// objects only) — only db/index.ts's connection construction is deferred.
export async function buildAuthConfig(): Promise<NextAuthConfig> {
  const { db } = await import('@/db/index');
  return {
    ...authConfig,
    adapter: DrizzleAdapter(db, {
      usersTable: users,
      accountsTable: accounts,
      sessionsTable: sessions,
      verificationTokensTable: verificationTokens,
    }),
    // PLT-04: overrides auth.config.ts's allow-all signIn callback with the
    // invite gate. auth.config.ts itself is NOT edited — auth.config.test.ts pins
    // `callbacks.signIn === signInCallback` there, and keeping the DB out of that
    // statically-imported file is FND-08's build-safety invariant. `invitedSignIn`
    // COMPOSES the base callback instead. Spread first so any future auth.config
    // callback survives.
    callbacks: { ...authConfig.callbacks, signIn: invitedSignIn },
    // auth.config.ts declares no `events` key today; if it ever does, spread it
    // here the same way.
    events: { createUser: attachInviteCodeToNewUser },
  };
}

// ---------------------------------------------------------------------------
// PLT-04 — invite-code gated registration (PRD §9 "上线初期以邀请码控制注册节奏").
// See docs/plans/PLT-04.md §2.4 for the verified Auth.js internals this depends on.
// ---------------------------------------------------------------------------

/**
 * The transport cookie's name. Shared with app/(auth)/signin/page.tsx by VALUE, not
 * by import: that file is `'use client'` and cannot import this server-only module.
 * page-invite.test.tsx pins the literal on the client side.
 */
export const INVITE_COOKIE_NAME = 'gw_invite_code';

/**
 * Reads the invite code the sign-in page stashed in a short-lived cookie.
 *
 * WHY A COOKIE AND NOT A `signIn()` OPTION: Auth.js does NOT forward extra fields
 * passed to `next-auth/react`'s `signIn()` to the `signIn` CALLBACK. They land in the
 * POST body, and @auth/core's `sendToken` reads only `body.email` while the OAuth
 * signin action reads only `request.query`. No request object reaches the callback at
 * all. A cookie is the only transport Auth.js v5 leaves open here — see
 * docs/plans/PLT-04.md §0 fact 10. Do not "simplify" this back to an option.
 *
 * `next/headers` is imported DYNAMICALLY, inside the function body: middleware.ts
 * imports `@/auth`, so anything statically imported here lands in the Edge middleware
 * bundle (same reason the `@/db/index` import above is deferred).
 *
 * Returns `null` rather than throwing when there is no request scope — the caller
 * then fails CLOSED (a missing code rejects the sign-up).
 */
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
 * The invite gate (ticket Deliverable 4). Exported so auth-invite.test.ts can invoke
 * it directly with fabricated @auth/core-shaped params.
 *
 * READ THIS BEFORE CHANGING THE ORDER OF THE BRANCHES.
 *
 * The Auth.js `signIn` callback receives NO `isNewUser` signal (its params are exactly
 * `{ user, account?, profile?, email?, credentials? }`; `isNewUser` exists only on the
 * `events.signIn` MESSAGE, which fires after the sign-in is already committed and
 * cannot block it). So new-vs-existing is determined here the same way @auth/core
 * itself determines it: an exact-match lookup on `users.email`.
 */
export async function invitedSignIn(params: SignInCallbackParams): Promise<boolean> {
  // 1. FND-08's base callback still runs first and still wins a `false`.
  if (!(await signInCallback())) return false;

  const { user, account, email: emailFlow } = params;

  // 2. Email provider, PHASE 2 — the magic link was clicked. The email provider
  //    invokes this callback TWICE: phase 1 in send-token.ts (with
  //    `email.verificationRequest === true`) BEFORE the link is generated and mailed,
  //    phase 2 when the link is clicked (with no `email` key). The gate already ran in
  //    phase 1, and phase 2 is unreachable without the single-use, AUTH_SECRET-hashed,
  //    24h verification token that phase 1 only creates AFTER this callback returned
  //    truthy. Re-gating here would instead break the legitimate cross-device case
  //    (link opened on a phone, which carries no cookie) and would re-check an
  //    already-spent code. THIS IS NOT A HOLE — see docs/plans/PLT-04.md §4 R10.
  if (account?.type === 'email' && emailFlow?.verificationRequest !== true) return true;

  // 3. No email ⇒ we cannot tell new from existing ⇒ fail closed.
  const address = user?.email;
  if (!address) return false;

  // Dynamic import for the same bundle reason as readInviteCodeCookie().
  const { isExistingUserEmail, redeemInviteCode } = await import(
    '@/lib/db/queries/invite-codes'
  );

  // 4. Existing account ⇒ untouched, no code ever requested (ticket Non-goals:
  //    "No changes to EXISTING users' sign-in flow"). EXACT-match by design — a
  //    case-insensitive "exists" where upstream would still create a new user is a
  //    silent gate bypass.
  if (await isExistingUserEmail(address)) return true;

  // 5. New account: a valid, unused code is mandatory. `null` for the user id — the
  //    users row does not exist yet (this callback runs before handleLoginOrRegister)
  //    and the id visible here is one the Drizzle adapter discards. This single
  //    guarded UPDATE is where the double-redemption race is decided.
  const code = await readInviteCodeCookie();
  if (!code) return false;
  return await redeemInviteCode(code, null);
}

/**
 * Fills in `invite_codes.used_by` once the `users` row actually exists (the sub-PRD's
 * "谁用了、何时用" tracking). `events.createUser` fires immediately after the row is
 * created, with the persisted user, for both providers.
 *
 * MUST NEVER THROW: @auth/core AWAITS this inside the callback route's try block, so
 * an exception would turn an otherwise-successful sign-in into a CallbackRouteError
 * AFTER the account already exists. Attribution is best-effort by design — a magic
 * link opened on another device carries no cookie, in which case `used_at` still
 * records the redemption (the pacing signal PRD §9 actually asks for) and `used_by`
 * stays null.
 */
async function attachInviteCodeToNewUser({
  user,
}: {
  user: { id?: string };
}): Promise<void> {
  try {
    const code = await readInviteCodeCookie();
    if (!code || !user?.id) return;
    const { attachInviteCodeUser } = await import('@/lib/db/queries/invite-codes');
    await attachInviteCodeUser(code, user.id);
  } catch (err) {
    // PRD §8.4 "不上 APM" — console.error is the whole error budget. Never the code,
    // never the email.
    console.error('[invite] could not attach invite code to the new user', { err });
  }
}

// Standard Auth.js v5 export shape. `signIn`/`signOut` here are the client/server
// ACTIONS that initiate/terminate a sign-in flow (e.g. signIn('google')) — a
// different thing from auth.config.ts's `signInCallback` (the gate that decides
// whether an attempt is allowed, PLT-04's future invite-code extension point).
export const { handlers, auth, signIn, signOut } = NextAuth(buildAuthConfig);
