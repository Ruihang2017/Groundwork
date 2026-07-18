import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the whole @/auth module BEFORE importing lib/auth/session.ts. This is
// required, not stylistic: @/auth transitively imports @/auth.config → @/db/index,
// and db/index.ts THROWS at import time when DATABASE_URL is unset. Mocking @/auth
// (not a deeper layer) keeps this test fully offline — no DATABASE_URL, no Google/
// Resend network calls, no Drizzle adapter — matching the repo's "no live DB in any
// test" convention. vi.mock is hoisted above the imports by Vitest, so this is safe
// regardless of import order.
vi.mock('@/auth', () => ({ auth: vi.fn() }));

import { auth } from '@/auth';
import { requireUserId, UnauthorizedError } from '@/lib/auth/session';

const mockedAuth = vi.mocked(auth);

describe('requireUserId()', () => {
  beforeEach(() => {
    mockedAuth.mockReset();
  });

  it('throws UnauthorizedError when auth() resolves to null (no session) — acceptance item 1', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedAuth.mockResolvedValue(null as any);
    await expect(requireUserId()).rejects.toThrow(UnauthorizedError);
  });

  it('returns the session user.id string when a valid session is mocked — acceptance item 2', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedAuth.mockResolvedValue({ user: { id: 'user-123' } } as any);
    await expect(requireUserId()).resolves.toBe('user-123');
  });

  it('throws UnauthorizedError when a session exists but user.id is missing (never resolves undefined)', async () => {
    // Proves Deliverable 5's "never silently returns an empty/undefined userId"
    // guarantee: a session object present but without user.id must still throw,
    // not resolve to undefined.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedAuth.mockResolvedValue({ user: {} } as any);
    await expect(requireUserId()).rejects.toThrow(UnauthorizedError);
  });

  it('throws UnauthorizedError when the session has no user object at all', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedAuth.mockResolvedValue({} as any);
    await expect(requireUserId()).rejects.toThrow(UnauthorizedError);
  });

  it('UnauthorizedError is catchable by instanceof and carries the expected name', async () => {
    // Downstream API routes catch this by `instanceof` (→ HTTP 401), not by string
    // match — assert the type is a real, importable class with a stable name.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedAuth.mockResolvedValue(null as any);
    try {
      await requireUserId();
      expect.unreachable('requireUserId() should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UnauthorizedError);
      expect(e).toBeInstanceOf(Error);
      expect((e as UnauthorizedError).name).toBe('UnauthorizedError');
    }
  });
});
