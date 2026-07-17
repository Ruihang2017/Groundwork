import { describe, expect, it } from 'vitest';

// @/auth.config is now DB-FREE (FND-08 Reviewer bounce fix, finding #1): the
// Drizzle adapter and its `@/db/index` import were moved into auth.ts's lazy
// request-time factory, so this module imports without DATABASE_URL and pulls in
// no database connection code. That build-safety property is asserted directly in
// auth.test.ts; here we cover the config's provider/session/callback shape
// (Deliverable 1) and, critically, the session callback's session-token filtering
// (finding #2). Everything is offline: no real Google/Resend credentials, no Neon.

async function loadConfig() {
  return import('@/auth.config');
}

describe('auth.config — provider + session wiring (Deliverable 1)', () => {
  it('registers exactly the Google and Resend providers', async () => {
    const { default: authConfig } = await loadConfig();
    const ids = authConfig.providers.map((p) =>
      typeof p === 'function' ? undefined : p.id,
    );
    expect(ids).toContain('google');
    expect(ids).toContain('resend');
    expect(authConfig.providers).toHaveLength(2);
  });

  it("uses the database session strategy (matches the Drizzle adapter's persisted-session model, not JWT)", async () => {
    const { default: authConfig } = await loadConfig();
    expect(authConfig.session?.strategy).toBe('database');
  });

  it('does NOT carry a static adapter (it is wired lazily in auth.ts — keeps the build DB-free, finding #1)', async () => {
    const { default: authConfig } = await loadConfig();
    // The adapter deliberately lives in auth.ts's buildAuthConfig() so that
    // importing this config (as `next build` does) never pulls in @/db/index.
    expect(
      (authConfig as { adapter?: unknown }).adapter,
    ).toBeUndefined();
  });
});

describe('auth.config — signInCallback extension point (Non-goals / §2.3)', () => {
  it('is exported as a named function that resolves to true (allow-all, no invite-code check yet)', async () => {
    const { signInCallback } = await loadConfig();
    expect(typeof signInCallback).toBe('function');
    await expect(signInCallback()).resolves.toBe(true);
  });

  it('is the same function wired into callbacks.signIn (PLT-04 wraps THIS, not the signIn action)', async () => {
    const { default: authConfig, signInCallback } = await loadConfig();
    expect(authConfig.callbacks?.signIn).toBe(signInCallback);
  });
});

describe('auth.config — session callback (finding #2: session-token exposure guard + user.id wiring)', () => {
  // @auth/core (database strategy) invokes callbacks.session with
  // session = { ...AdapterSession, user } and returns its result VERBATIM as the
  // GET /api/auth/session body. AdapterSession carries `sessionToken` (the exact
  // httpOnly cookie value) and a top-level `userId`. This test feeds a fabricated
  // AdapterSession-shaped input (matching @auth/core's real call shape) and proves
  // the callback (a) populates user.id and (b) does NOT leak the token / raw
  // AdapterSession fields to the client. requireUserId()'s own tests mock a
  // fabricated { user: { id } } and would stay green even if this callback were
  // broken — this is the only offline test that exercises it.
  async function runSessionCallback() {
    const { default: authConfig } = await loadConfig();
    const sessionCb = authConfig.callbacks?.session;
    expect(sessionCb).toBeDefined();

    const expires = new Date('2099-01-01T00:00:00.000Z');
    const input = {
      session: {
        sessionToken: 'super-secret-httponly-cookie-value',
        userId: 'db-user-1',
        expires,
        user: { name: 'Ada', email: 'ada@example.com', image: null },
      },
      user: { id: 'db-user-1', name: 'Ada', email: 'ada@example.com' },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (sessionCb as any)(input);
    return { result, expires };
  }

  it('copies the AdapterUser row id onto session.user.id (requireUserId depends on it)', async () => {
    const { result } = await runSessionCallback();
    expect(result.user.id).toBe('db-user-1');
  });

  it('does NOT expose the raw sessionToken to the client (httpOnly-defeating leak guard)', async () => {
    const { result } = await runSessionCallback();
    // The token must appear nowhere in the returned (client-facing) payload.
    expect(JSON.stringify(result)).not.toContain(
      'super-secret-httponly-cookie-value',
    );
    expect(result.sessionToken).toBeUndefined();
  });

  it('does NOT expose the top-level AdapterSession userId field', async () => {
    const { result } = await runSessionCallback();
    expect(result.userId).toBeUndefined();
  });

  it('keeps only the presentation-safe subset (user name/email/image + expires as ISO string)', async () => {
    const { result, expires } = await runSessionCallback();
    expect(result.user.name).toBe('Ada');
    expect(result.user.email).toBe('ada@example.com');
    expect(result.user.image).toBe(null);
    expect(result.expires).toBe(expires.toISOString());
    // No stray AdapterSession keys beyond user + expires.
    expect(Object.keys(result).sort()).toEqual(['expires', 'user']);
  });
});
