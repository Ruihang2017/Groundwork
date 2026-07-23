import { NextResponse } from 'next/server';

import { isAdminEmail } from '@/app/(admin)/_lib/admin-emails';
import { auth } from '@/auth';

// Route groups (app/(app)/**, app/(auth)/**, app/(legal)/**) are invisible in the
// actual request URL — "protect app/(app)/** routes" (ticket Deliverable 4) is
// therefore implemented as "protect every page route EXCEPT this explicit
// allowlist," not as a literal `/(app)/...` path matcher (which would never match
// any real request — see FND-08 plan §0). Extend this SET, not the matcher below,
// when a later ticket adds new public pages (e.g. app/(legal)/** — see plan §5
// Open Question #3 for who owns that edit).
const PUBLIC_PATHS = new Set<string>([
  '/', // app/page.tsx — public landing page
  '/signin', // app/(auth)/signin/page.tsx (FND-09) — must stay reachable while logged out
  '/privacy', // app/(legal)/privacy/page.tsx (PLT-01) — legal page, readable while logged out
  '/tos', // app/(legal)/tos/page.tsx (PLT-01) — legal page, readable while logged out
]);

// PLT-03 — /admin is served by app/(admin)/admin/page.tsx. Route groups are
// invisible in request URLs (see this file's header comment above), so the
// ticket's "gate app/(admin)/**" is implemented as a pathname test on '/admin',
// never as a literal '(admin)' segment matcher.
//
// SEGMENT-SCOPED on purpose, exactly like the `api/` lookahead in config.matcher
// below (FND-08 Reviewer finding #3): a bare startsWith('/admin') would also
// swallow a future '/administrators' or '/admin-guide' page. That direction fails
// closed, so it is not an exploit — but it is a bug class this repo already paid
// for once, and middleware.test.ts guards it.
function isAdminPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/');
}

export default auth((req) => {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  if (!req.auth) {
    const signInUrl = new URL('/signin', req.nextUrl.origin);
    return NextResponse.redirect(signInUrl);
  }

  // PLT-03 — /admin AUTHORIZATION. Ordering is load-bearing: this runs AFTER the
  // authentication guard above, so an UNAUTHENTICATED /admin request keeps
  // redirecting to /signin exactly as before this append. Gating /admin before
  // the auth check would answer "this path exists and you are not signed in"
  // instead of running the normal sign-in flow.
  //
  // 403 rather than a redirect (the ticket allows either): it cannot loop, is
  // directly assertable in middleware.test.ts, and does not bounce an
  // already-authenticated user back to a sign-in page they are already past.
  // Non-disclosure is not a goal — /admin's existence is in the public PRD. The
  // body stays a bare 'Forbidden': no diagnostics, no echo of the email.
  //
  // `req.auth.user?.email` — the optional chain is required for type safety and
  // is itself fail-closed (undefined ⇒ isAdminEmail(undefined) ⇒ false). Under
  // auth.config.ts's `session: { strategy: 'database' }` this email comes from
  // the users row via the session() callback, NOT from a client-supplied JWT, so
  // it is not forgeable by the browser.
  //
  // This is the EARLY gate, not the only one. config.matcher below excludes
  // /api/** entirely, so a FUTURE admin API route would NOT inherit this check
  // and must call isAdminEmail() itself; and middleware runs in a different
  // runtime with its own env semantics (see admin-emails.ts). That is why
  // app/(admin)/admin/page.tsx repeats the check before touching any data — do
  // not delete that one on the grounds that "middleware handles it".
  if (isAdminPath(pathname) && !isAdminEmail(req.auth.user?.email)) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  return NextResponse.next();
});

export const config = {
  // Excludes /api/** entirely (every API route enforces its own auth via
  // requireUserId() — see lib/auth/session.ts — and /api/auth/** specifically MUST
  // stay reachable unauthenticated or the OAuth/magic-link flow itself breaks) and
  // Next.js's own static/image/favicon internals.
  //
  // `api/` (with the trailing slash), NOT bare `api`: the negative lookahead is a
  // PREFIX test, so a bare `api` would also exclude any future page route whose
  // first segment merely STARTS WITH "api" (e.g. /api-docs, /apiary) — silently
  // serving it unauthenticated with no error (FND-08 Reviewer finding #3). The
  // trailing slash scopes the exclusion to the real `/api/` segment only, so
  // `/api-docs` etc. stay protected. `/api/**` (the auth endpoints) still match
  // `api/` and remain excluded.
  matcher: ['/((?!api/|_next/static|_next/image|favicon.ico).*)'],
  // If empirical testing (once Horace provisions real DATABASE_URL/OAuth
  // credentials — this repo has neither yet) shows the Edge runtime rejects the
  // Drizzle/neon-http adapter call inside auth() above, uncomment:
  // runtime: 'nodejs', // stable since Next.js 15.5 (this repo pins ^15.5.20)
};
