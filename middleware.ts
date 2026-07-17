import { NextResponse } from 'next/server';

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
]);

export default auth((req) => {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  if (!req.auth) {
    const signInUrl = new URL('/signin', req.nextUrl.origin);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
});

export const config = {
  // Excludes /api/** entirely (every API route enforces its own auth via
  // requireUserId() — see lib/auth/session.ts — and /api/auth/** specifically MUST
  // stay reachable unauthenticated or the OAuth/magic-link flow itself breaks) and
  // Next.js's own static/image/favicon internals. Mirrors Auth.js's own official
  // example matcher.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
  // If empirical testing (once Horace provisions real DATABASE_URL/OAuth
  // credentials — this repo has neither yet) shows the Edge runtime rejects the
  // Drizzle/neon-http adapter call inside auth() above, uncomment:
  // runtime: 'nodejs', // stable since Next.js 15.5 (this repo pins ^15.5.20)
};
