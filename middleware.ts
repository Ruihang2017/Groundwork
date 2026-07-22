import { NextResponse } from 'next/server';

import { isAdminEmail } from '@/app/(admin)/_lib/admin-access';
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
// never as a literal '(admin)' segment.
//
// SEGMENT-SCOPED on purpose, exactly like the `api/` lookahead in config.matcher
// below (FND-08 Reviewer finding #3): a bare startsWith('/admin') would also
// swallow a future '/administrators' or '/admin-guide' page.
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

  // PLT-03 — admin gate. Runs AFTER the auth check above, so an unauthenticated
  // /admin request keeps redirecting to /signin exactly as before this append.
  // 403 rather than a redirect (the ticket allows either): it is unambiguous in
  // a test, cannot loop, and does not bounce an already-authenticated user back
  // to a sign-in page they are already past. The body stays a bare 'Forbidden' —
  // no diagnostics, no echo of the email.
  //
  // This is the EARLY, cheap gate, not the authoritative one: middleware runs in
  // a different runtime with its own env semantics (see admin-access.ts) and
  // Next.js middleware has a documented history of framework-level bypass
  // classes. app/(admin)/admin/page.tsx repeats the check before touching any
  // data — do not delete that one on the grounds that "middleware handles it".
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
