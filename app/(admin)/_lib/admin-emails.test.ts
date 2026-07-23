import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isAdminEmail, parseAdminEmails } from '@/app/(admin)/_lib/admin-emails';

// PLT-03 — the fail-closed contract of the admin allowlist predicate. This is a
// security boundary: every case below is the negative one somebody would
// otherwise discover in production.
//
// process.env is saved/restored per test rather than mocked: the module under
// test reads process.env.ADMIN_EMAILS at CALL time (deliberately — see its
// header), so no vi.resetModules()/doMock dance is needed. If a future edit moves
// that read to module scope these tests go green-but-meaningless, which is why
// the "changes take effect without re-importing" case below exists.
const ORIGINAL = process.env.ADMIN_EMAILS;

function setAllowlist(value: string | undefined) {
  if (value === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = value;
}

beforeEach(() => setAllowlist(undefined));
afterEach(() => setAllowlist(ORIGINAL));

describe('parseAdminEmails', () => {
  it('splits, trims and lowercases entries into a set', () => {
    expect(parseAdminEmails('a@x.com, B@Y.com ,  c@z.com')).toEqual(
      new Set(['a@x.com', 'b@y.com', 'c@z.com']),
    );
  });

  it('yields an EMPTY set for undefined / empty / whitespace / comma-only input', () => {
    // The load-bearing one: ''.split(',') is [''], so without the length filter
    // an unset env var would produce a set containing the empty string.
    expect(parseAdminEmails(undefined)).toEqual(new Set());
    expect(parseAdminEmails('')).toEqual(new Set());
    expect(parseAdminEmails('   ')).toEqual(new Set());
    expect(parseAdminEmails(',')).toEqual(new Set());
    expect(parseAdminEmails(' , , ')).toEqual(new Set());
    expect(parseAdminEmails('').has('')).toBe(false);
  });

  it('drops blank entries between real ones without dropping the real ones', () => {
    expect(parseAdminEmails('a@x.com,, ,b@x.com')).toEqual(
      new Set(['a@x.com', 'b@x.com']),
    );
  });
});

describe('isAdminEmail — fail-closed on configuration', () => {
  it('denies every email when ADMIN_EMAILS is UNSET', () => {
    expect(isAdminEmail('horace@example.com')).toBe(false);
    expect(isAdminEmail('anyone@anywhere.dev')).toBe(false);
  });

  it('denies every email when ADMIN_EMAILS is empty', () => {
    setAllowlist('');
    expect(isAdminEmail('horace@example.com')).toBe(false);
  });

  it('denies every email when ADMIN_EMAILS is only separators/whitespace', () => {
    setAllowlist(',');
    expect(isAdminEmail('horace@example.com')).toBe(false);
    setAllowlist(' , ');
    expect(isAdminEmail('horace@example.com')).toBe(false);
    setAllowlist('   ');
    expect(isAdminEmail('horace@example.com')).toBe(false);
  });

  it('does NOT throw when ADMIN_EMAILS is unset (an exception inside middleware invites a fail-OPEN catch)', () => {
    expect(() => isAdminEmail('horace@example.com')).not.toThrow();
    expect(() => isAdminEmail(undefined)).not.toThrow();
  });
});

describe('isAdminEmail — fail-closed on the session email', () => {
  beforeEach(() => setAllowlist('horace@example.com'));

  it('denies a null / undefined / empty / whitespace-only email even with a populated allowlist', () => {
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
    expect(isAdminEmail('')).toBe(false);
    expect(isAdminEmail('   ')).toBe(false);
  });

  it('denies an address that is not listed', () => {
    expect(isAdminEmail('someone-else@example.com')).toBe(false);
  });

  it('denies a SUBSTRING of a listed address (set membership, never includes())', () => {
    setAllowlist('aa@example.com');
    expect(isAdminEmail('a@example.com')).toBe(false);
    expect(isAdminEmail('@example.com')).toBe(false);
    expect(isAdminEmail('example.com')).toBe(false);
  });

  it('denies a listed address with extra characters appended', () => {
    expect(isAdminEmail('horace@example.com.attacker.dev')).toBe(false);
  });
});

describe('isAdminEmail — allows exactly the listed addresses', () => {
  it('allows an exact match', () => {
    setAllowlist('horace@example.com');
    expect(isAdminEmail('horace@example.com')).toBe(true);
  });

  it('matches case-insensitively on BOTH sides', () => {
    setAllowlist('Horace@Example.COM');
    expect(isAdminEmail('horace@example.com')).toBe(true);
    setAllowlist('horace@example.com');
    expect(isAdminEmail('HORACE@EXAMPLE.COM')).toBe(true);
  });

  it('matches with surrounding whitespace on BOTH sides', () => {
    setAllowlist(' Horace@Example.COM ');
    expect(isAdminEmail('  horace@example.com  ')).toBe(true);
  });

  it('allows any entry of a multi-address allowlist', () => {
    setAllowlist('a@x.com, b@y.com,c@z.com');
    expect(isAdminEmail('a@x.com')).toBe(true);
    expect(isAdminEmail('b@y.com')).toBe(true);
    expect(isAdminEmail('c@z.com')).toBe(true);
    expect(isAdminEmail('d@w.com')).toBe(false);
  });

  it('reads process.env at CALL time — a change takes effect with no re-import', () => {
    setAllowlist('first@example.com');
    expect(isAdminEmail('first@example.com')).toBe(true);
    expect(isAdminEmail('second@example.com')).toBe(false);

    setAllowlist('second@example.com');
    expect(isAdminEmail('first@example.com')).toBe(false);
    expect(isAdminEmail('second@example.com')).toBe(true);

    setAllowlist(undefined);
    expect(isAdminEmail('second@example.com')).toBe(false);
  });
});
