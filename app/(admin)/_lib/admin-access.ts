// PLT-03 — the single definition of "is this email an admin".
//
// PRD names NO admin-authorization mechanism anywhere. This env-var email
// allowlist is docs/prd/07-platform-launch/README.md's decision-table choice and
// is recorded there as OPEN QUESTION #1 (owner: Horace, pending confirmation) —
// see docs/plans/PLT-03.md §5 Q1 and the ticket's Feedback obligation #1. Do not
// treat it as settled; if Horace prefers a database `isAdmin` flag or a single
// hardcoded account, this file is the one place that changes.
//
// Lives in `app/(admin)/_lib/` because the identical predicate is needed in TWO
// runtimes — Edge (middleware.ts) and Node (the /admin server component) — and
// two inline copies is how one of them silently drifts. `_lib` is a Next.js
// private folder (leading underscore): never routable.
//
// Deliberately imports nothing: no DB, no React, no `next/*`. It must stay
// Edge-safe and importable with no environment configured at all.

/**
 * Parsed `ADMIN_EMAILS`, read at CALL time and never cached at module scope.
 *
 * Call-time reads matter twice over: middleware.test.ts's `vi.stubEnv` cases
 * would silently assert against a stale module-scope snapshot, and in production
 * the Node-runtime page picks up an env change without a module reload.
 *
 * The key is written as a LITERAL `process.env.ADMIN_EMAILS`: Next.js inlines
 * `process.env.<LITERAL>` into the Edge middleware bundle, and a dynamic
 * `process.env[key]` lookup does not work there at all. Consequence to expect
 * (docs/plans/PLT-03.md R3/§5 Q5, unverifiable offline — no live deployment
 * exists yet): changing ADMIN_EMAILS may require a REDEPLOY, not just an
 * env-var edit, for the middleware half of the gate. The page-level check runs
 * in the Node runtime and reads process.env per request, which is why that one
 * is the authoritative gate.
 */
function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
}

/**
 * True only if `email` appears in the `ADMIN_EMAILS` allowlist.
 *
 * FAILS CLOSED, by construction (docs/plans/PLT-03.md R1 — an "unconfigured
 * means everyone" reading would hand every signed-in user the global cost and
 * funnel data):
 *
 * 1. Unset / empty / whitespace-only / `",,"`-only `ADMIN_EMAILS` ⇒ nobody is an
 *    admin.
 * 2. Never throws. `process.env.ADMIN_EMAILS` is `undefined` when unset, and an
 *    unguarded `undefined.split(',')` would 500 *inside middleware* on every
 *    /admin request — after which the tempting "fix" is a catch that fails OPEN.
 *    The `?? ''` is what keeps that pressure off.
 * 3. Blank entries are filtered out BEFORE comparison: `''.split(',')` is `['']`,
 *    so without the filter a session whose email is `''` would match.
 * 4. Both sides are trimmed and lowercased. Env values pick up spaces after
 *    commas and providers vary the case they hand back. This deliberately
 *    *widens* the match set (`Horace@x.com` matches `horace@x.com`) — the
 *    standard trade-off: it prevents a lockout, and the mailbox itself is still
 *    the authentication factor (Google OAuth verifies it; the Resend magic link
 *    proves control of it).
 *
 * The parameter accepts `string | null | undefined` because that is exactly what
 * next-auth's `Session['user'].email` is under this repo's auth.config.ts.
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const allowlist = adminEmails();
  if (allowlist.length === 0) return false;
  return allowlist.includes(email.trim().toLowerCase());
}
