import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @/auth so `auth(handler)` is a pass-through that hands back the inner
// request handler unchanged — this lets the test capture and invoke the handler
// directly. Same import-time reason as lib/auth/session.test.ts: @/auth →
// @/auth.config → @/db/index throws without DATABASE_URL. vi.mock is hoisted.
vi.mock('@/auth', () => ({
  auth: (handler: (req: unknown) => unknown) => handler,
}));

import middleware, { config } from '@/middleware';

// At runtime @/auth is mocked to a pass-through, so the default export IS the
// single-arg inner request handler. TypeScript still sees the real NextAuth
// handler type (which expects a 2nd NextFetchEvent arg this test doesn't use), so
// cast to the actual runtime shape.
const runMiddleware = middleware as unknown as (req: unknown) => Response;

// Minimal request shape the handler actually reads: nextUrl (a real URL, which
// supplies both .pathname and .origin) and auth (the session or null).
function fakeReq(pathname: string, auth: unknown) {
  return { nextUrl: new URL(`http://localhost${pathname}`), auth };
}

function isRedirect(res: Response): boolean {
  return res.status >= 300 && res.status < 400 && res.headers.has('location');
}

describe('middleware — matcher config (acceptance item 3)', () => {
  const matcher = (config.matcher as string[])[0];
  // The emitted matcher is a Next.js negative-lookahead pattern that is also a
  // valid JS regex; anchor it and test real request URLs against it.
  const re = new RegExp(`^${matcher}$`);

  it('exports a single-entry matcher array', () => {
    expect(Array.isArray(config.matcher)).toBe(true);
    expect((config.matcher as string[]).length).toBe(1);
  });

  it('EXCLUDES /api/** so the sign-in / OAuth / magic-link flow is never intercepted (critical correctness guard)', () => {
    expect(re.test('/api/auth/session')).toBe(false);
    expect(re.test('/api/auth/callback/google')).toBe(false);
    expect(re.test('/api/anything')).toBe(false);
  });

  it("excludes Next.js's own static/image/favicon internals", () => {
    expect(re.test('/_next/static/chunk.js')).toBe(false);
    expect(re.test('/_next/image')).toBe(false);
    expect(re.test('/favicon.ico')).toBe(false);
  });

  it('MATCHES a representative protected page path', () => {
    expect(re.test('/jobs')).toBe(true);
    expect(re.test('/library')).toBe(true);
  });

  it('MATCHES (protects) page routes whose first segment merely STARTS WITH "api" — the exclusion is segment-scoped via "api/", not prefix-scoped (finding #3)', () => {
    // With a bare `api` lookahead these would be silently excluded from the auth
    // middleware and served unauthenticated; `api/` scopes the exclusion to the
    // real /api/ segment only, so these page routes stay protected.
    expect(re.test('/api-docs')).toBe(true);
    expect(re.test('/apiary')).toBe(true);
    expect(re.test('/apis')).toBe(true);
  });

  it('does not special-case literal route-group segments (they never appear in a real URL)', () => {
    expect(matcher).not.toContain('(app)');
    expect(matcher).not.toContain('(auth)');
    expect(matcher).not.toContain('(legal)');
  });
});

describe('middleware — request handling (acceptance item 3)', () => {
  it('redirects an UNAUTHENTICATED request to a protected path → /signin', () => {
    const res = runMiddleware(fakeReq('/jobs', null)) as Response;
    expect(isRedirect(res)).toBe(true);
    expect(res.headers.get('location')).toMatch(/\/signin$/);
  });

  it('lets an AUTHENTICATED request to a protected path pass through (no redirect)', () => {
    const res = runMiddleware(fakeReq('/jobs', { user: { id: 'user-123' } })) as Response;
    expect(isRedirect(res)).toBe(false);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('lets the public landing page "/" through even when unauthenticated', () => {
    const res = runMiddleware(fakeReq('/', null)) as Response;
    expect(isRedirect(res)).toBe(false);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('lets "/signin" through even when unauthenticated (must stay reachable while logged out)', () => {
    const res = runMiddleware(fakeReq('/signin', null)) as Response;
    expect(isRedirect(res)).toBe(false);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  // PLT-01 — legal pages (app/(legal)/**) must be reachable by logged-out
  // visitors (e.g. before signing up). Same pass-through shape as / and /signin.
  it('lets "/privacy" through even when unauthenticated (PLT-01 legal page)', () => {
    const res = runMiddleware(fakeReq('/privacy', null)) as Response;
    expect(isRedirect(res)).toBe(false);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('lets "/tos" through even when unauthenticated (PLT-01 legal page)', () => {
    const res = runMiddleware(fakeReq('/tos', null)) as Response;
    expect(isRedirect(res)).toBe(false);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });
});

// PLT-03 — the /admin AUTHORIZATION gate (ticket acceptance item 4), appended
// without touching anything above. No vi.resetModules() anywhere here on
// purpose: app/(admin)/_lib/admin-emails.ts reads process.env.ADMIN_EMAILS at
// CALL time. If a future edit moves that read to module scope, these tests start
// asserting against a stale snapshot — the fix is that module, not a resetModules
// here.
describe('middleware — /admin authorization gate (PLT-03, acceptance item 4)', () => {
  const ORIGINAL_ADMIN_EMAILS = process.env.ADMIN_EMAILS;

  beforeEach(() => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
  });

  afterEach(() => {
    if (ORIGINAL_ADMIN_EMAILS === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = ORIGINAL_ADMIN_EMAILS;
  });

  it('REJECTS /admin with 403 for an authenticated session whose email is NOT allowlisted (item 4a)', () => {
    const res = runMiddleware(
      fakeReq('/admin', { user: { id: 'u1', email: 'nobody@example.com' } }),
    ) as Response;
    expect(res.status).toBe(403);
    expect(isRedirect(res)).toBe(false);
  });

  it('ALLOWS /admin for an allowlisted email (item 4b)', () => {
    const res = runMiddleware(
      fakeReq('/admin', { user: { id: 'u1', email: 'admin@example.com' } }),
    ) as Response;
    expect(isRedirect(res)).toBe(false);
    expect(res.status).not.toBe(403);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('ALLOWS an allowlisted email differing in case and surrounded by whitespace', () => {
    const res = runMiddleware(
      fakeReq('/admin', { user: { id: 'u1', email: ' ADMIN@Example.com ' } }),
    ) as Response;
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('REJECTS an authenticated session carrying NO email', () => {
    expect((runMiddleware(fakeReq('/admin', { user: { id: 'u1' } })) as Response).status).toBe(
      403,
    );
    expect((runMiddleware(fakeReq('/admin', {})) as Response).status).toBe(403);
  });

  it('FAILS CLOSED when ADMIN_EMAILS is unset or blank — nobody reaches /admin', () => {
    delete process.env.ADMIN_EMAILS;
    expect(
      (runMiddleware(fakeReq('/admin', { user: { email: 'admin@example.com' } })) as Response)
        .status,
    ).toBe(403);

    process.env.ADMIN_EMAILS = '  ,  ';
    expect(
      (runMiddleware(fakeReq('/admin', { user: { email: 'admin@example.com' } })) as Response)
        .status,
    ).toBe(403);
  });

  it('redirects an UNAUTHENTICATED /admin request to /signin — NOT a 403 (ordering guard)', () => {
    // Authentication first, authorization second. A 403 here would leak "this
    // path exists and you are not signed in" instead of the normal sign-in flow.
    const res = runMiddleware(fakeReq('/admin', null)) as Response;
    expect(isRedirect(res)).toBe(true);
    expect(res.headers.get('location')).toMatch(/\/signin$/);
    expect(res.status).not.toBe(403);
  });

  it('gates nested /admin/** paths too', () => {
    expect(
      (runMiddleware(fakeReq('/admin/usage', { user: { email: 'nobody@example.com' } })) as Response)
        .status,
    ).toBe(403);
    expect(
      (runMiddleware(fakeReq('/admin/a/b', { user: { email: 'nobody@example.com' } })) as Response)
        .status,
    ).toBe(403);
    expect(
      (runMiddleware(fakeReq('/admin/usage', { user: { email: 'admin@example.com' } })) as Response)
        .headers.get('x-middleware-next'),
    ).toBe('1');
  });

  it('does NOT admin-gate a path that merely STARTS WITH "/admin" (segment-scoped, FND-08 finding #3 class)', () => {
    // A bare startsWith('/admin') would 403 these for every non-admin user. They
    // are ordinary authenticated pages and must pass through untouched.
    for (const path of ['/administrators', '/admin-guide', '/adminx']) {
      const res = runMiddleware(fakeReq(path, { user: { email: 'nobody@example.com' } })) as Response;
      expect(res.status, path).not.toBe(403);
      expect(res.headers.get('x-middleware-next'), path).toBe('1');
    }
  });

  it('leaves non-admin protected paths unaffected by the allowlist', () => {
    const res = runMiddleware(
      fakeReq('/jobs', { user: { id: 'u1', email: 'nobody@example.com' } }),
    ) as Response;
    expect(res.status).not.toBe(403);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('keeps /admin matched by config.matcher (the gate is only reachable if middleware runs at all)', () => {
    const re = new RegExp(`^${(config.matcher as string[])[0]}$`);
    expect(re.test('/admin')).toBe(true);
    expect(re.test('/admin/usage')).toBe(true);
  });
});
