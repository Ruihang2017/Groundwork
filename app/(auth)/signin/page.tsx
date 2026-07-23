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

// PLT-04 — the invite code's carrier. It travels to the server in a cookie, NOT in
// the signIn() options, because Auth.js's signIn CALLBACK (the gate, auth.ts's
// createInviteGate) receives no request and Google's flow offers no server-side
// hook before the redirect — by the time the gate runs for Google, the browser is
// arriving fresh from accounts.google.com with no form body. See auth.ts's PLT-04
// block comment for the full derivation.
const INVITE_COOKIE_NAME = 'gw_invite';

function writeInviteCookie(code: string) {
  const trimmed = code.trim();
  // `Secure` ONLY over https: jsdom (and a local `next dev` on http://localhost)
  // silently discards a Secure cookie over http, which would make this a no-op in
  // both the component test and local development.
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  // SameSite=Lax, NEVER Strict: the Google callback is a cross-site-initiated
  // top-level GET navigation, and Strict would withhold the cookie there —
  // breaking Google sign-up entirely.
  //
  // Max-Age=86400 matches @auth/core's 24h verification-token lifetime, so
  // attribution still works when a magic link is opened hours later in the same
  // browser.
  //
  // THE EMPTY BRANCH (delete) IS MANDATORY, not defensive tidiness: it is what
  // makes that long Max-Age safe. Every sign-in attempt starts on this page and
  // runs this helper, so a code left behind by one visitor can never be silently
  // consumed by a different new user on a shared browser.
  document.cookie = trimmed
    ? `${INVITE_COOKIE_NAME}=${encodeURIComponent(trimmed)}; Path=/; Max-Age=86400; SameSite=Lax${secure}`
    : `${INVITE_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

export default function SignInPage() {
  const [email, setEmail] = useState('');
  const [inviteCode, setInviteCode] = useState('');

  return (
    <section style={{ maxWidth: '24rem' }}>
      <h1>Sign in</h1>

      {/* Google sign-UP is gated too, so the cookie must be written here as well —
          wiring the invite field only into the magic-link form below would let
          anyone create an account through Google. The button is deliberately NOT
          disabled when the field is empty: a RETURNING Google user needs no code
          (ticket Non-goal 3). */}
      <button
        type="button"
        onClick={() => {
          writeInviteCookie(inviteCode);
          signIn('google', { callbackUrl: CALLBACK_URL });
        }}
      >
        Continue with Google
      </button>

      <hr style={{ margin: '1.5rem 0' }} />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          writeInviteCookie(inviteCode);
          // `inviteCode` is passed here as well because PLT-04's Deliverable 5
          // asks for it literally and it documents intent (next-auth/react
          // form-encodes extra options into the POST body). NOTHING READS IT —
          // the cookie above is the only channel, since the Google flow cannot
          // use a body at all. Do not "fix" the server gate to depend on this.
          signIn('resend', { email, inviteCode, callbackUrl: CALLBACK_URL });
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
        {/* NOT `required`: a RETURNING user signing in by magic link must be able
            to submit this form with the field empty (ticket Non-goal 3 — existing
            users are never asked for a code). The label says so explicitly. */}
        <label htmlFor="inviteCode">Invite code (new accounts only)</label>
        <input
          id="inviteCode"
          name="inviteCode"
          type="text"
          value={inviteCode}
          onChange={(e) => setInviteCode(e.target.value)}
          placeholder="XXXX-XXXX-XXXX"
          autoComplete="off"
        />

        <button type="submit">Send magic link</button>
      </form>
    </section>
  );
}
