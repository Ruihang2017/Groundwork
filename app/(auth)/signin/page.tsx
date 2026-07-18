'use client';

import { useState } from 'react';

// Client-safe sign-in surface (next-auth/react), NOT @/auth. @/auth's signIn/signOut
// import next/headers + next/navigation at module top and cannot be imported into a
// 'use client' file — doing so fails Next.js's client/server boundary check at build
// time. next-auth/react's signIn() is Auth.js's own officially-supported Client
// Components API (a plain browser fetch against /api/auth/**, no <SessionProvider>
// needed since this page uses no useSession()). See docs/plans/FND-09.md §0.3.
// Do NOT "simplify" this to import signIn from '@/auth' — it will break `next build`.
import { signIn } from 'next-auth/react';

// callbackUrl targets /home (app/(app)/home/page.tsx, this ticket's placeholder
// authenticated landing) — without it, next-auth/react's signIn() defaults the
// post-sign-in redirect to the current page (/signin), bouncing the user back to
// the form. Keep this slug in sync with app/(app)/home/page.tsx if either moves.
const CALLBACK_URL = '/home';

export default function SignInPage() {
  const [email, setEmail] = useState('');

  return (
    <section style={{ maxWidth: '24rem' }}>
      <h1>Sign in</h1>

      <button
        type="button"
        onClick={() => signIn('google', { callbackUrl: CALLBACK_URL })}
      >
        Continue with Google
      </button>

      <hr style={{ margin: '1.5rem 0' }} />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          signIn('resend', { email, callbackUrl: CALLBACK_URL });
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}
      >
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />

        {/* INVITE_CODE_INSERTION_POINT — PLT-04 (07-platform-launch) inserts an
            <InviteCodeField /> input here; append only, do not restructure this form. */}

        <button type="submit">Send magic link</button>
      </form>
    </section>
  );
}
