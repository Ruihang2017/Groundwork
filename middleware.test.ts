import { describe, expect, it, vi } from 'vitest';

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
});
