// PLT-03 — the single definition of "is this email an admin".
//
// PRD names NO admin-authorization mechanism anywhere. This env-var email
// allowlist is docs/prd/07-platform-launch/README.md's decision-table choice and
// is recorded there as OPEN QUESTION #1 (owner: Horace, pending confirmation) —
// see docs/plans/PLT-03.md §2.1/§5 Q1 and the ticket's Feedback obligation #1.
// Do NOT treat it as settled: if Horace prefers a `users.isAdmin` column or a
// single hardcoded account, this file plus middleware.ts's one branch are the
// only code that changes. If he CONFIRMS it, promote the decision to
// docs/adr/0001-admin-authorization.md at that point (this repo has no ADR yet,
// and writing one for a decision still awaiting its owner would misrepresent it).
//
// Lives in `app/(admin)/_lib/` because the identical predicate is needed in TWO
// runtimes — Edge (middleware.ts) and Node (the /admin server component) — and
// two inline copies is how one of them silently drifts. `_lib` is a Next.js
// private folder (leading underscore): never routable. This path is a documented
// File-scope widening (the ticket enumerates only app/(admin)/admin/**), covered
// by docs/prd/breakdown-plan.md §3's module-level `app/(admin)/**` glob — see the
// ticket Changelog.
//
// Deliberately imports NOTHING: no DB, no React, no `next/*`. It must stay
// Edge-safe and importable with no environment configured at all.

/**
 * Parses an `ADMIN_EMAILS` value ("a@x.com, B@Y.com") into a normalized lookup
 * set: trimmed, lowercased, blanks removed.
 *
 * The `.filter(...)` is LOAD-BEARING, not tidiness: `''.split(',')` is `['']`,
 * so without it an unset/empty env var yields a set containing the empty string
 * and any session whose email normalizes to `''` would match. Exported so
 * app/(admin)/_lib/admin-emails.test.ts can pin that directly.
 */
export function parseAdminEmails(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.length > 0),
  );
}

/**
 * True only if `email` appears in the `ADMIN_EMAILS` allowlist.
 *
 * FAILS CLOSED in every direction (docs/plans/PLT-03.md §4):
 *
 * 1. Unset / empty / whitespace-only / `",,"`-only `ADMIN_EMAILS` ⇒ nobody is an
 *    admin. An "unconfigured means everyone" reading would hand every signed-in
 *    user the global cost and funnel data.
 * 2. `null` / `undefined` / blank email ⇒ denied, even with a populated
 *    allowlist.
 * 3. Never throws. `process.env.ADMIN_EMAILS` is `undefined` when unset, and an
 *    unguarded `undefined.split(',')` would 500 *inside middleware* on every
 *    /admin request — after which the tempting "fix" is a catch that fails OPEN.
 *    The `?? ''` inside parseAdminEmails is what keeps that pressure off.
 * 4. Both sides are trimmed and lowercased: env values pick up spaces after
 *    commas, and providers vary the case they hand back. This deliberately
 *    WIDENS the match set (`Horace@X.com` matches `horace@x.com`) — the standard
 *    trade-off: it prevents a lockout, and the mailbox itself is still the
 *    authentication factor (Google OAuth verifies it; the Resend magic link
 *    proves control of it).
 * 5. Set MEMBERSHIP, never a substring test: `a@x.com` must not match a listed
 *    `aa@x.com`.
 *
 * `process.env` is read at CALL time, never cached at module scope: tests set and
 * unset ADMIN_EMAILS per case with no `vi.resetModules()`, and the Node-runtime
 * page picks up an env change without a module reload.
 *
 * The key is written as a LITERAL `process.env.ADMIN_EMAILS`: Next.js inlines
 * `process.env.<LITERAL>` into the Edge middleware bundle, and a computed
 * `process.env[key]` is not statically analysable and would read `undefined`
 * there (which fails closed — i.e. locks everyone out — but is a confusing
 * outage). Consequence to expect, unverifiable offline (no live deployment
 * exists yet — plan §4 "Edge env inlining", §5 Q6): changing ADMIN_EMAILS may
 * require a REDEPLOY, not just an env edit, for the middleware half of the gate.
 * The page-level check runs in the Node runtime and reads process.env per
 * request, which is why that one is the authoritative gate.
 *
 * The parameter accepts `string | null | undefined` because that is exactly what
 * next-auth's `Session['user'].email` is under this repo's auth.config.ts.
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  const allowlist = parseAdminEmails(process.env.ADMIN_EMAILS);
  // Deliberately redundant with `.has()` on an empty set — it exists so the
  // fail-closed intent is unmissable to a reader. Keep it, and keep this comment.
  if (allowlist.size === 0) return false;
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return false;
  return allowlist.has(normalized);
}
