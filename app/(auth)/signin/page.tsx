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

// --- PLT-04: invite-code gated registration (PRD §9) -------------------------
// Must equal auth.ts's INVITE_COOKIE_NAME. NOT imported: @/auth is server-only and
// importing it into a 'use client' file breaks `next build` (see the header above).
const INVITE_COOKIE_NAME = 'gw_invite_code';

// 30 minutes: long enough that a magic link clicked on the SAME device still carries
// the code for attribution (auth.ts's events.createUser), short enough that a shared
// machine does not keep it around. The gate itself never needs it after the form POST.
const INVITE_COOKIE_MAX_AGE_SECONDS = 1800;

/**
 * The invite code cannot be passed through signIn()'s options — Auth.js does not
 * forward request-body fields to the signIn CALLBACK (docs/plans/PLT-04.md §0 fact
 * 10) — so it travels in a cookie the server reads there. Written before EVERY
 * signIn() call, for BOTH providers, because either can create a new account.
 *
 * SECURITY: the value is normalized and shape-checked before it is concatenated into
 * document.cookie. Writing raw user input here would let a ';' inject cookie
 * attributes (path/domain/expiry). Rejecting silently is correct — the server-side
 * gate is what enforces validity, and an unwritable value simply fails closed there.
 *
 * The trim/upper-case must match lib/db/queries/invite-codes.ts's
 * normalizeInviteCode(), or a legitimately-minted code becomes unredeemable.
 *
 * `samesite=lax` (not `strict`) is load-bearing: the Google flow returns via a
 * top-level cross-site GET redirect from accounts.google.com, which `lax` allows and
 * `strict` would drop — a `strict` cookie silently breaks Google sign-ups for new
 * users.
 */
function rememberInviteCode(raw: string): void {
  const value = raw.trim().toUpperCase();
  if (!/^[A-Z0-9-]{0,64}$/.test(value)) return;
  const secure = window.location.protocol === 'https:' ? '; secure' : '';
  document.cookie =
    `${INVITE_COOKIE_NAME}=${encodeURIComponent(value)}; path=/; ` +
    `max-age=${INVITE_COOKIE_MAX_AGE_SECONDS}; samesite=lax${secure}`;
}

export default function SignInPage() {
  const [email, setEmail] = useState('');
  const [inviteCode, setInviteCode] = useState('');

  return (
    <section style={{ maxWidth: '24rem' }}>
      <h1>Sign in</h1>

      <button
        type="button"
        onClick={() => {
          rememberInviteCode(inviteCode);
          signIn('google', { callbackUrl: CALLBACK_URL });
        }}
      >
        Continue with Google
      </button>

      <hr style={{ margin: '1.5rem 0' }} />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          rememberInviteCode(inviteCode);
          // `inviteCode` is passed in the options ONLY because the ticket's
          // Deliverable 5 asks for it and it costs nothing (@auth/core's sendToken
          // ignores unknown body fields). THE COOKIE ABOVE IS THE LOAD-BEARING
          // TRANSPORT — do not delete the rememberInviteCode() call believing this
          // option does the work. It does not reach the signIn callback.
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

        {/* INVITE_CODE_INSERTION_POINT — PLT-04 (07-platform-launch) inserted the
            invite-code input here; append only, do not restructure this form.

            Deliberately NOT `required`: the same field serves returning users (who
            need no code, per the ticket's Non-goals) and the Google button ABOVE this
            form — a `required` attribute would block the magic-link submit for every
            returning user. The helper text carries what the layout cannot. Whether
            the field should sit above the provider buttons is plan §5 Q3, for
            Horace — a follow-up ticket, not a silent restructure here. */}
        <label htmlFor="invite-code">Invite code</label>
        <input
          id="invite-code"
          name="inviteCode"
          type="text"
          autoComplete="off"
          value={inviteCode}
          onChange={(e) => setInviteCode(e.target.value)}
          placeholder="Required for new accounts"
        />
        <p style={{ fontSize: '0.85rem', margin: 0 }}>
          New accounts need an invite code — it applies to Google sign-in too. Already
          have an account? Leave it blank.
        </p>

        <button type="submit">Send magic link</button>
      </form>
    </section>
  );
}
