// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// PLT-04 — the invite-code field on the sign-in page (Deliverable 5).
//
// A SEPARATE FILE from FND-09's page.test.tsx (plan §2.7), which stays byte-for-byte
// unmodified as a regression guard that the invite append did not restructure the
// form or break either provider button.
//
// @testing-library/react's automatic cleanup only self-registers when a global
// afterEach exists (vitest `globals: true`). This repo's vitest.config.ts does NOT
// enable globals — same explicit hook page.test.tsx uses.
afterEach(cleanup);

vi.mock('next-auth/react', () => ({ signIn: vi.fn() }));

import { signIn } from 'next-auth/react';

import SignInPage from '@/app/(auth)/signin/page';

const COOKIE_NAME = 'gw_invite_code';

/** jsdom keeps ONE document per file, so cookies leak between tests without this. */
function clearCookies() {
  for (const pair of document.cookie.split(';')) {
    const name = pair.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; path=/; max-age=0`;
  }
}

function readCookie(): string | undefined {
  return document.cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);
}

beforeEach(() => {
  clearCookies();
  vi.mocked(signIn).mockReset();
});

describe('SignInPage — invite-code field (Deliverable 5)', () => {
  it('renders an invite-code input', () => {
    render(<SignInPage />);
    expect(screen.getByLabelText(/invite code/i)).toBeTruthy();
  });

  it('writes the cookie BEFORE calling signIn("google", …)', () => {
    // The assertion lives INSIDE the signIn mock so the ORDERING is actually proven,
    // not merely the end state. The Google button can create a new account too, which
    // is why the cookie must be written on that path as well.
    let cookieAtCallTime: string | undefined;
    vi.mocked(signIn).mockImplementation((() => {
      cookieAtCallTime = readCookie();
      return undefined as never;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);

    render(<SignInPage />);
    fireEvent.change(screen.getByLabelText(/invite code/i), {
      target: { value: 'ABC123XYZ9' },
    });
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));

    expect(cookieAtCallTime).toBe('ABC123XYZ9');
    expect(signIn).toHaveBeenCalledWith(
      'google',
      expect.objectContaining({ callbackUrl: '/home' }),
    );
  });

  it('writes the cookie before the magic-link submit and forwards inviteCode in the options', () => {
    let cookieAtCallTime: string | undefined;
    vi.mocked(signIn).mockImplementation((() => {
      cookieAtCallTime = readCookie();
      return undefined as never;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);

    render(<SignInPage />);
    fireEvent.change(screen.getByLabelText(/^email$/i), {
      target: { value: 'user@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/invite code/i), {
      target: { value: 'ABC123XYZ9' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(cookieAtCallTime).toBe('ABC123XYZ9');
    // The option is the ticket's literal Deliverable 5 wording; the COOKIE is what
    // actually reaches the signIn callback (Auth.js does not forward body fields).
    expect(signIn).toHaveBeenCalledWith(
      'resend',
      expect.objectContaining({
        email: 'user@example.com',
        inviteCode: 'ABC123XYZ9',
        callbackUrl: '/home',
      }),
    );
  });

  it('stores the code trimmed and upper-cased (must match normalizeInviteCode)', () => {
    render(<SignInPage />);
    fireEvent.change(screen.getByLabelText(/invite code/i), {
      target: { value: '  abc123xyz9  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));

    expect(readCookie()).toBe('ABC123XYZ9');
  });

  it('writes NO cookie for an input containing cookie metacharacters (injection guard)', () => {
    // A raw `;` in document.cookie would let the user inject cookie ATTRIBUTES
    // (path/domain/expiry). Rejecting silently is correct: the server-side gate is
    // what enforces validity, and an unwritten value simply fails closed there.
    for (const hostile of ['abc; domain=evil.com', 'abc=def', 'abc,def', 'a b c']) {
      clearCookies();
      cleanup();
      render(<SignInPage />);
      fireEvent.change(screen.getByLabelText(/invite code/i), {
        target: { value: hostile },
      });
      fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));
      expect(readCookie()).toBeUndefined();
    }
  });

  it('still calls signIn with an EMPTY invite field — returning users are not blocked client-side', () => {
    // The gate is server-side; a returning user needs no code (ticket Non-goals), so
    // the field is deliberately not `required`.
    render(<SignInPage />);
    fireEvent.change(screen.getByLabelText(/^email$/i), {
      target: { value: 'back@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(signIn).toHaveBeenCalledWith(
      'resend',
      expect.objectContaining({ email: 'back@example.com', inviteCode: '' }),
    );
  });
});
