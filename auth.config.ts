import type { NextAuthConfig } from 'next-auth';
import Google from 'next-auth/providers/google';
import Resend from 'next-auth/providers/resend';

// IMPORTANT (FND-08 Reviewer bounce fix, finding #1 — clean-checkout `pnpm build`
// blocker): this config is deliberately DB-FREE. The Drizzle adapter (and its
// `@/db/index` import) lives in auth.ts's lazy `NextAuth(async () => …)` factory,
// NOT here. `@/db/index` throws at import time when DATABASE_URL is unset (an
// intentional, tested FND-05 fail-fast — see db/index.test.ts), and `next build`
// imports this whole config chain during "Collecting page data". A static `db`
// import anywhere in the statically-loaded config therefore breaks `pnpm build`
// on any checkout without DATABASE_URL (including CI, which sets none). Keeping db
// out of the static graph and behind the request-time factory keeps the build
// DB-free while preserving FND-05's runtime fail-fast. See auth.ts + plan §4.

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
  session: { strategy: 'database' },
  callbacks: {
    signIn: signInCallback,
    // Under `session: { strategy: 'database' }`, @auth/core calls this with
    // `session = { ...AdapterSession, user }` and returns whatever this callback
    // yields VERBATIM as the GET /api/auth/session response body (see
    // @auth/core/lib/actions/session.js). The spread AdapterSession carries
    // `sessionToken` — the EXACT value of the httpOnly session cookie — plus a
    // top-level `userId`. Returning `session` as-is would therefore expose the
    // session token (a durable bearer credential) in JSON to any same-origin
    // script, defeating the cookie's httpOnly protection (FND-08 Reviewer finding
    // #2). Return ONLY the presentation-safe subset, adding `user.id` (required by
    // requireUserId() for query scoping — the AdapterUser row is the authoritative
    // id source, only available under the database strategy). Never spread
    // `session`. Mirrors @auth/core's own default JWT-strategy filter.
    session({ session, user }) {
      return {
        user: {
          id: user.id,
          name: session.user.name,
          email: session.user.email,
          image: session.user.image,
        },
        expires: session.expires.toISOString(),
      };
    },
  },
} satisfies NextAuthConfig;

export default authConfig;
