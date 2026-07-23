import { DrizzleAdapter } from '@auth/drizzle-adapter';
import NextAuth, {
  type DefaultSession,
  type NextAuthConfig,
} from 'next-auth';

import authConfig, { signInCallback } from '@/auth.config';
import { accounts, sessions, users, verificationTokens } from '@/db/schema';
import {
  attributeInviteCode,
  hasExistingUserWithEmail,
  redeemInviteCode,
} from '@/lib/db/queries/invite-codes';

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
// =============================================================================
// PLT-04 — invite-code gated registration (PRD §9 "上线初期以邀请码控制注册节奏").
//
// WHY THE CODE ARRIVES IN A COOKIE (the one architecturally load-bearing choice
// here — it is FORCED, not preferred; plan §2.0, rejected alternatives in §4 R-6):
//
//   - `callbacks.signIn` receives NO request and no way to read a POST body
//     (@auth/core calls it with `{ user, account, profile? , email? }` only).
//   - For Google there is NO server-side hook before the redirect: the gate can
//     only run at `GET /api/auth/callback/google`, a fresh top-level navigation
//     back from Google carrying no form body. Whatever was typed into the sign-in
//     form is long gone by then unless the browser re-sends it.
//   - `NextAuth(factory)` DOES hand the live Request to this factory on every
//     /api/auth/** call, so a request-scoped cookie is the only channel that
//     reaches the gate for BOTH providers.
//
// `gw_invite` is client-written and client-readable BY DESIGN. It is not a
// security boundary and carries a user-supplied value, never a server secret —
// every security property of this feature comes from the atomic server-side
// redemption in lib/db/queries/invite-codes.ts. Nothing may ever be TRUSTED merely
// because it arrived in this cookie.
// =============================================================================

export const INVITE_COOKIE_NAME = 'gw_invite';

/**
 * Longest invite code we will even look at. Real codes are 14 chars
 * (XXXX-XXXX-XXXX, scripts/generate-invite-codes.mjs); the slack is for format
 * changes, not for user input.
 */
const MAX_INVITE_CODE_LENGTH = 64;

/**
 * Pull `gw_invite` out of a request's Cookie header, or `undefined` if it is
 * absent, empty, malformed, over-long, or contains anything outside [A-Za-z0-9-].
 *
 * Parsed BY HAND from `Request.headers` rather than via `next/headers` or
 * `NextRequest.cookies`: this module's static import graph is bundled into the
 * EDGE middleware (middleware.ts → @/auth), where `next/headers` is not available
 * — the same class of build break FND-08 already paid for once. Plain `Request` is
 * also exactly what both call sites (the route handler and middleware) supply.
 *
 * The length/charset filter is defence in depth, not the primary defence (drizzle
 * parameterises every query); it simply means nothing shaped unlike a code ever
 * reaches SQL. `undefined` request ⇒ `undefined`: the factory is also invoked with
 * no request at all from React Server Components and the signIn/signOut server
 * actions.
 */
export function readInviteCodeCookie(req?: Request): string | undefined {
  const header = req?.headers?.get('cookie');
  if (!header) return undefined;

  for (const part of header.split(';')) {
    const pair = part.trim();
    // Split at the FIRST '=' only — a base32 code contains none, but a
    // co-resident cookie's value may.
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() !== INVITE_COOKIE_NAME) continue;

    const raw = pair.slice(eq + 1).trim();
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      // A malformed escape (e.g. '%zz') throws URIError; treat as absent.
      return undefined;
    }

    const value = decoded.trim();
    if (!value) return undefined;
    if (value.length > MAX_INVITE_CODE_LENGTH) return undefined;
    if (!/^[A-Za-z0-9-]+$/.test(value)) return undefined;
    return value;
  }

  return undefined;
}

/** The subset of @auth/core's signIn-callback parameters this gate reads. */
type InviteGateParams = {
  user?: { email?: string | null } | null;
  account?: { type?: string | null } | null;
  email?: { verificationRequest?: boolean } | null;
};

/**
 * Build the invite-code gate for ONE request, closed over that request's cookie
 * value. `deps` exists purely so auth.test.ts can drive the decision logic with
 * plain fakes — no DB, no PGlite, no module mocking.
 *
 * DECISION ORDER IS LOAD-BEARING:
 *
 *   1. An EXISTING user is never asked for a code, for any provider, cookie or no
 *      cookie (ticket Non-goal 3). This check runs FIRST so a returning user can
 *      neither be denied nor charged a code.
 *   2. The magic-link CLICK is not re-gated. @auth/core calls signIn TWICE for the
 *      email provider: once when the mail is REQUESTED (`email.verificationRequest
 *      === true`) and once when the link is CLICKED (no `email` key at all). Step 4
 *      already consumed a code to get that mail sent, and reaching the click step
 *      requires a valid verification token that only the gated step could mint.
 *      Re-gating here would deny every user who opens the link on a different
 *      device, where the cookie does not exist.
 *   3/4. Otherwise a code is required and is consumed HERE — the single
 *      consumption point per sign-in attempt. Google consumes at
 *      GET /api/auth/callback/google; Resend consumes at
 *      POST /api/auth/signin/resend, which also stops that endpoint being a free,
 *      ungated email-sending amplifier (a real Resend cost — PRD §9).
 *
 * ACCEPTED TRADE-OFF, recorded so it is not rediscovered as a bug (plan §4 R-2):
 * a magic-link code is burned when the email is REQUESTED, not when the link is
 * clicked. A lost/spam-filtered email therefore burns the code (remedy: mint
 * another, or clear that row's `used_at`). The alternative — validate on request,
 * consume on click — restores retries but denies cross-device link opening and
 * lets one code trigger unlimited emails. "One code ⇒ one email ⇒ at most one
 * account" is the stronger pacing property, so this side was chosen.
 *
 * A THROWN redeemInviteCode (DB down) FAILS CLOSED: @auth/core converts it to
 * AccessDenied. That is correct for a gate — do NOT "helpfully" add a
 * `catch → true`.
 *
 * ORDERING HAZARD (plan §4 R-7): this gate runs BEFORE the user row is created, so
 * if creation then fails (e.g. OAuthAccountNotLinked) the code is already spent.
 * Unfixable without a reservation protocol, operationally recoverable by clearing
 * `used_at`. Do NOT attempt to "un-redeem" in a catch block — that reintroduces a
 * race.
 */
export function createInviteGate(
  inviteCode: string | undefined,
  deps?: {
    hasExistingUserWithEmail?: typeof hasExistingUserWithEmail;
    redeemInviteCode?: typeof redeemInviteCode;
    attributeInviteCode?: typeof attributeInviteCode;
  },
) {
  const isExistingUser = deps?.hasExistingUserWithEmail ?? hasExistingUserWithEmail;
  const redeem = deps?.redeemInviteCode ?? redeemInviteCode;
  const attribute = deps?.attributeInviteCode ?? attributeInviteCode;

  return {
    async signIn(params: InviteGateParams): Promise<boolean> {
      // 1. Returning user — never gated (Non-goal 3).
      if (await isExistingUser(params?.user?.email)) return true;

      // 2. The magic-link click, not the request. See the header.
      if (
        params?.account?.type === 'email' &&
        params?.email?.verificationRequest !== true
      ) {
        return true;
      }

      // 3. New account creation with no code.
      if (!inviteCode) return false;

      // 4. Consume. `null`, not user.id: there is no users row yet — see
      //    redeemInviteCode's own comment. Attribution happens in createUser.
      return await redeem(inviteCode, null);
    },

    /**
     * Fill in `invite_codes.used_by` once a real `users.id` finally exists.
     *
     * MUST NEVER THROW. @auth/core wraps the whole callback branch: a throw here
     * becomes a CallbackRouteError and fails a sign-in whose account row has
     * ALREADY been created. Attribution is advisory (db/schema.ts's invite_codes
     * rule 3), so a failure is logged and swallowed.
     */
    async createUser(params: { user: { id?: string | null } }): Promise<void> {
      // `id` is optional in next-auth's own `User` type even though the adapter
      // always supplies it here; a missing one simply means nothing to attribute.
      const userId = params?.user?.id;
      if (!inviteCode || !userId) return;
      try {
        await attribute(inviteCode, userId);
      } catch (err) {
        // PRD §8.4 "不上 APM" — console.error is the whole error-observability
        // budget (matches lib/usage/record.ts and the account-delete route).
        console.error('[invite] attribution failed', err);
      }
    },
  };
}

export async function buildAuthConfig(req?: Request): Promise<NextAuthConfig> {
  const { db } = await import('@/db/index');
  // PLT-04: the request is the ONLY carrier of the invite code (see the block
  // comment above). `req` is optional because next-auth calls this same factory
  // with `undefined` from React Server Components and the signIn/signOut server
  // actions, and with a NextRequest from middleware.
  //
  // DO NOT read req.body / req.text() / req.formData() here. The body is a
  // single-use stream that @auth/core still needs; consuming it makes the email
  // provider's sendToken see `email === undefined` and throw.
  const gate = createInviteGate(readInviteCodeCookie(req));
  return {
    ...authConfig,
    adapter: DrizzleAdapter(db, {
      usersTable: users,
      accountsTable: accounts,
      sessionsTable: sessions,
      verificationTokensTable: verificationTokens,
    }),
    callbacks: {
      // Spread — do NOT retype. `...authConfig.callbacks` preserves auth.config's
      // `session` callback, whose job is to strip `sessionToken` out of the
      // /api/auth/session response (FND-08 Reviewer finding #2). Dropping it
      // silently re-opens that session-token leak.
      ...authConfig.callbacks,
      // auth.config.ts:16-21 invites PLT-04 to "wrap OR replace" signInCallback;
      // this WRAPS it, so a future FND-08-side change to the base gate keeps
      // taking effect. auth.config.ts itself stays byte-for-byte unmodified (its
      // test asserts the STATIC config's callbacks.signIn === signInCallback —
      // only this per-request config object overrides it).
      signIn: async (params) =>
        (await signInCallback()) && (await gate.signIn(params)),
    },
    events: {
      // auth.config.ts currently declares no `events` key at all, so the cast is
      // what lets this spread be written FORWARD-COMPATIBLY: the day FND-08's
      // config grows an event handler, it keeps being honoured here instead of
      // being silently dropped by a hand-written `events: { createUser }`.
      ...(authConfig as NextAuthConfig).events,
      createUser: gate.createUser,
    },
  };
}

// Standard Auth.js v5 export shape. `signIn`/`signOut` here are the client/server
// ACTIONS that initiate/terminate a sign-in flow (e.g. signIn('google')) — a
// different thing from auth.config.ts's `signInCallback` (the gate that decides
// whether an attempt is allowed, PLT-04's future invite-code extension point).
export const { handlers, auth, signIn, signOut } = NextAuth(buildAuthConfig);
