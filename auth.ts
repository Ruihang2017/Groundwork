import { DrizzleAdapter } from '@auth/drizzle-adapter';
import NextAuth, {
  type DefaultSession,
  type NextAuthConfig,
} from 'next-auth';

import authConfig from '@/auth.config';
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
  };
}

// Standard Auth.js v5 export shape. `signIn`/`signOut` here are the client/server
// ACTIONS that initiate/terminate a sign-in flow (e.g. signIn('google')) — a
// different thing from auth.config.ts's `signInCallback` (the gate that decides
// whether an attempt is allowed, PLT-04's future invite-code extension point).
export const { handlers, auth, signIn, signOut } = NextAuth(buildAuthConfig);
