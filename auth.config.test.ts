import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// This is the ONE test file in FND-08's suite that imports the REAL (non-mocked)
// @/auth.config. @/auth.config → @/db/index throws at import time without
// DATABASE_URL, so set a syntactically valid dummy URL before importing (neon()
// construction is lazy/network-free — same proven pattern as db/index.test.ts).
// Everything here is offline: no real Google/Resend credentials, no live Neon.

const ORIGINAL_URL = process.env.DATABASE_URL;

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = 'postgresql://user:pass@fake-host.example.invalid/db';
});

afterEach(() => {
  if (ORIGINAL_URL === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = ORIGINAL_URL;
  }
});

async function loadConfig() {
  return import('@/auth.config');
}

describe('auth.config — provider + adapter + session wiring (Deliverable 1)', () => {
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

  it('wires a defined adapter (DrizzleAdapter constructs without a live connection)', async () => {
    const { default: authConfig } = await loadConfig();
    expect(authConfig.adapter).toBeDefined();
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

describe('auth.config — session callback populates user.id (top mock-passes-but-real-breaks guard)', () => {
  it('copies the AdapterUser row id onto session.user.id', async () => {
    const { default: authConfig } = await loadConfig();
    const sessionCb = authConfig.callbacks?.session;
    expect(sessionCb).toBeDefined();

    const input = {
      session: { user: { name: 'Ada', email: 'ada@example.com' } },
      user: { id: 'db-user-1' },
    };
    // Call the real callback directly. This is the only offline test that exercises
    // the database-strategy user.id wiring — requireUserId()'s own tests mock a
    // fabricated { user: { id } } and would stay green even if this callback were
    // missing entirely (see plan §4).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (sessionCb as any)(input) as { user: { id: string } };
    expect(result.user.id).toBe('db-user-1');
  });
});
