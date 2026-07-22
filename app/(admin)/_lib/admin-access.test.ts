import { afterEach, describe, expect, it, vi } from 'vitest';

import { isAdminEmail } from '@/app/(admin)/_lib/admin-access';

// Plain unit test: no DB, no jsdom, no module reset. vi.stubEnv works WITHOUT
// vi.resetModules() precisely because admin-access.ts reads process.env at CALL
// time — if someone caches the allowlist at module scope, these tests silently
// start asserting against a stale value, so this file is also the regression
// guard for that.
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isAdminEmail — allowlist matching', () => {
  it('[machine] returns true for an exact match', () => {
    vi.stubEnv('ADMIN_EMAILS', 'admin@example.com');
    expect(isAdminEmail('admin@example.com')).toBe(true);
  });

  it('[machine] matches any entry in a multi-entry list, not just the first', () => {
    vi.stubEnv('ADMIN_EMAILS', 'first@example.com,second@example.com,third@example.com');
    expect(isAdminEmail('first@example.com')).toBe(true);
    expect(isAdminEmail('second@example.com')).toBe(true);
    expect(isAdminEmail('third@example.com')).toBe(true);
  });

  it('[machine] returns false for an unlisted email', () => {
    vi.stubEnv('ADMIN_EMAILS', 'admin@example.com');
    expect(isAdminEmail('nobody@example.com')).toBe(false);
  });

  it('[machine] tolerates spaces around commas on both sides', () => {
    vi.stubEnv('ADMIN_EMAILS', '  a@x.com , b@y.com  ');
    expect(isAdminEmail('a@x.com')).toBe(true);
    expect(isAdminEmail('b@y.com')).toBe(true);
    expect(isAdminEmail('  a@x.com ')).toBe(true);
  });

  it('[machine] matches case-insensitively in both directions', () => {
    vi.stubEnv('ADMIN_EMAILS', 'Admin@X.com');
    expect(isAdminEmail('admin@x.com')).toBe(true);

    vi.stubEnv('ADMIN_EMAILS', 'admin@x.com');
    expect(isAdminEmail('ADMIN@X.COM')).toBe(true);
  });
});

describe('isAdminEmail — fails closed (R1: the whole point of this file)', () => {
  it('[machine] returns false when ADMIN_EMAILS is UNSET — never "unconfigured means everyone"', () => {
    vi.stubEnv('ADMIN_EMAILS', undefined);
    expect(process.env.ADMIN_EMAILS).toBeUndefined();
    expect(isAdminEmail('admin@example.com')).toBe(false);
  });

  it('[machine] returns false when ADMIN_EMAILS is empty', () => {
    vi.stubEnv('ADMIN_EMAILS', '');
    expect(isAdminEmail('admin@example.com')).toBe(false);
  });

  it('[machine] returns false when ADMIN_EMAILS is whitespace-only', () => {
    vi.stubEnv('ADMIN_EMAILS', '   ');
    expect(isAdminEmail('admin@example.com')).toBe(false);
  });

  it('[machine] returns false when ADMIN_EMAILS is commas-only', () => {
    vi.stubEnv('ADMIN_EMAILS', ',,');
    expect(isAdminEmail('admin@example.com')).toBe(false);
  });

  it('[machine] returns false for a null / undefined / empty session email', () => {
    vi.stubEnv('ADMIN_EMAILS', 'admin@example.com');
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
    expect(isAdminEmail('')).toBe(false);
    expect(isAdminEmail('   ')).toBe(false);
  });

  it("[machine] the ''.split(',') === [''] trap: a blank email does not match a blank allowlist", () => {
    // Without the .filter() in adminEmails(), ''.split(',') is [''] and a
    // session email of '' would match it — an empty allowlist would authorize a
    // user with no email.
    vi.stubEnv('ADMIN_EMAILS', '');
    expect(isAdminEmail('')).toBe(false);
    vi.stubEnv('ADMIN_EMAILS', ',');
    expect(isAdminEmail('')).toBe(false);
    expect(isAdminEmail('   ')).toBe(false);
  });

  it('[machine] never throws for any of these inputs (an unguarded split would 500 inside middleware)', () => {
    const envValues = [undefined, '', '   ', ',,', 'a@x.com', ' a@x.com , '];
    const emails = [null, undefined, '', '   ', 'a@x.com', 'A@X.COM'];
    for (const env of envValues) {
      vi.stubEnv('ADMIN_EMAILS', env);
      for (const email of emails) {
        expect(() => isAdminEmail(email)).not.toThrow();
      }
    }
  });
});
