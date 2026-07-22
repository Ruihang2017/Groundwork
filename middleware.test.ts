import { afterEach, describe, expect, it, vi } from 'vitest';

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

// --- PLT-03: the /admin allowlist gate ---------------------------------------
// APPENDED to this 01-foundation-owned file; nothing above is restructured. The
// existing fakeReq/isRedirect helpers are reused verbatim.
//
// vi.stubEnv works here WITHOUT vi.resetModules() because
// app/(admin)/_lib/admin-access.ts reads process.env at CALL time — if that ever
// gets cached at module scope these tests silently assert against a stale value.
describe('middleware — /admin allowlist gate (PLT-03 acceptance item 4)', () => {
  const admin = { user: { id: 'u1', email: 'admin@example.com' } };
  const nonAdmin = { user: { id: 'u2', email: 'nobody@example.com' } };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('[machine] REJECTS /admin with 403 for a session whose email is NOT in ADMIN_EMAILS', () => {
    vi.stubEnv('ADMIN_EMAILS', 'admin@example.com');
    const res = runMiddleware(fakeReq('/admin', nonAdmin)) as Response;
    expect(res.status).toBe(403);
    // 403, not a redirect: unambiguous, cannot loop, and does not bounce an
    // already-authenticated user to a sign-in page they are already past.
    expect(isRedirect(res)).toBe(false);
  });

  it('[machine] ALLOWS /admin for an allowlisted email (pass-through, no redirect)', () => {
    vi.stubEnv('ADMIN_EMAILS', 'admin@example.com');
    const res = runMiddleware(fakeReq('/admin', admin)) as Response;
    expect(isRedirect(res)).toBe(false);
    expect(res.status).not.toBe(403);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('[machine] still redirects an UNAUTHENTICATED /admin request to /signin (pre-existing behavior preserved)', () => {
    vi.stubEnv('ADMIN_EMAILS', 'admin@example.com');
    const res = runMiddleware(fakeReq('/admin', null)) as Response;
    expect(isRedirect(res)).toBe(true);
    expect(res.headers.get('location')).toMatch(/\/signin$/);
  });

  it('[machine] FAILS CLOSED: 403 even for the "right" email when ADMIN_EMAILS is unset (R1)', () => {
    vi.stubEnv('ADMIN_EMAILS', undefined);
    const res = runMiddleware(fakeReq('/admin', admin)) as Response;
    expect(res.status).toBe(403);
  });

  it('[machine] gates SUB-PATHS of /admin too, not just the exact path', () => {
    vi.stubEnv('ADMIN_EMAILS', 'admin@example.com');
    expect((runMiddleware(fakeReq('/admin/usage', nonAdmin)) as Response).status).toBe(403);
    expect(
      (runMiddleware(fakeReq('/admin/usage', admin)) as Response).headers.get('x-middleware-next'),
    ).toBe('1');
  });

  it('[machine] is SEGMENT-scoped: /administrators is NOT swallowed by the /admin gate (R5, same bug class as finding #3)', () => {
    vi.stubEnv('ADMIN_EMAILS', 'admin@example.com');
    for (const path of ['/administrators', '/admin-guide', '/adminfoo']) {
      const res = runMiddleware(fakeReq(path, nonAdmin)) as Response;
      expect(res.status).not.toBe(403);
      expect(res.headers.get('x-middleware-next')).toBe('1');
    }
  });

  it('[machine] gates nothing else: /settings is an unchanged pass-through for a non-admin', () => {
    vi.stubEnv('ADMIN_EMAILS', 'admin@example.com');
    const res = runMiddleware(fakeReq('/settings', nonAdmin)) as Response;
    expect(isRedirect(res)).toBe(false);
    expect(res.status).not.toBe(403);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('[machine] the existing matcher already covers /admin — no matcher change was needed', () => {
    const re = new RegExp(`^${(config.matcher as string[])[0]}$`);
    expect(re.test('/admin')).toBe(true);
    expect(re.test('/admin/usage')).toBe(true);
  });
});
