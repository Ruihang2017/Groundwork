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
