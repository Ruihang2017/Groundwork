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
