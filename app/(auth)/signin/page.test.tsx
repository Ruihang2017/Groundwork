// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// @testing-library/react's automatic cleanup only self-registers when a global
// afterEach exists (i.e. vitest `globals: true`). This repo's vitest.config.ts does
// NOT enable globals, so without this explicit hook each render() would accumulate
// in the shared jsdom document.body and later queries would fail with
// "multiple elements found". Scoped here rather than flipping the global config.
afterEach(cleanup);

// Mock the actual function the page calls (next-auth/react's client signIn — see
// docs/plans/FND-09.md §0.3/§2.7). No real network/OAuth call happens either way;
// this satisfies acceptance item 2's "mocking FND-08's signIn, not making real
// OAuth calls". vi.mock is hoisted above the imports below.
vi.mock('next-auth/react', () => ({ signIn: vi.fn() }));

import { signIn } from 'next-auth/react';

import SignInPage from '@/app/(auth)/signin/page';

describe('SignInPage (acceptance item 2)', () => {
  it('renders a Google button and an email magic-link form', () => {
    render(<SignInPage />);
    expect(
      screen.getByRole('button', { name: /continue with google/i }),
    ).toBeTruthy();
    expect(screen.getByLabelText(/email/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /send/i })).toBeTruthy();
  });

  it('clicking "Continue with Google" calls signIn("google", …) — not a real OAuth call', () => {
    render(<SignInPage />);
    fireEvent.click(
      screen.getByRole('button', { name: /continue with google/i }),
    );
    expect(signIn).toHaveBeenCalledWith(
      'google',
      expect.objectContaining({ callbackUrl: '/home' }),
    );
  });

  it('submitting the email form calls signIn("resend", { email, … })', () => {
    render(<SignInPage />);
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'user@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(signIn).toHaveBeenCalledWith(
      'resend',
      expect.objectContaining({
        email: 'user@example.com',
        callbackUrl: '/home',
      }),
    );
  });
});

// --- PLT-04: the invite-code field + its cookie carrier (Deliverable 5) --------
describe('SignInPage — invite code (PLT-04)', () => {
  /** Wipe gw_invite between tests: document.cookie is shared jsdom state. */
  function clearInviteCookie() {
    document.cookie = 'gw_invite=; Path=/; Max-Age=0; SameSite=Lax';
  }
  afterEach(clearInviteCookie);

  function inviteInput() {
    return screen.getByLabelText(/invite code/i);
  }

  it('renders a labelled invite-code input that is NOT required', () => {
    render(<SignInPage />);
    const input = inviteInput() as HTMLInputElement;
    expect(input).toBeTruthy();
    // NOT required: a returning user signing in by magic link must be able to
    // submit with it empty (ticket Non-goal 3 — existing users are never asked
    // for a code). A `required` here would lock every returning user out.
    expect(input.required).toBe(false);
  });

  it('does not disable the Google button when the field is empty (returning Google users)', () => {
    render(<SignInPage />);
    const button = screen.getByRole('button', {
      name: /continue with google/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it('submitting the magic-link form writes the code to the gw_invite cookie AND still calls signIn("resend", …)', () => {
    render(<SignInPage />);
    fireEvent.change(screen.getByLabelText(/^email$/i), {
      target: { value: 'user@example.com' },
    });
    fireEvent.change(inviteInput(), { target: { value: 'K7QD-2M9V-XBTR' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(document.cookie).toContain('gw_invite=K7QD-2M9V-XBTR');
    expect(signIn).toHaveBeenCalledWith(
      'resend',
      expect.objectContaining({
        email: 'user@example.com',
        callbackUrl: '/home',
      }),
    );
  });

  it('clicking "Continue with Google" ALSO writes the cookie — Google sign-up is gated too', () => {
    // Wiring the field only into the magic-link form would let anyone create an
    // account through Google, since the gate runs identically for both providers.
    render(<SignInPage />);
    fireEvent.change(inviteInput(), { target: { value: 'K7QD-2M9V-XBTR' } });
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));

    expect(document.cookie).toContain('gw_invite=K7QD-2M9V-XBTR');
    expect(signIn).toHaveBeenCalledWith(
      'google',
      expect.objectContaining({ callbackUrl: '/home' }),
    );
  });

  it('submitting with the field EMPTY CLEARS any leftover cookie (the shared-browser guard)', () => {
    // This is what makes the 24h Max-Age safe: every sign-in attempt starts on
    // this page and runs the cookie writer, so a code left behind by one visitor
    // can never be silently consumed by a different new user on the same browser.
    document.cookie = 'gw_invite=STALE-CODE-0001; Path=/; SameSite=Lax';
    expect(document.cookie).toContain('gw_invite=STALE-CODE-0001');

    render(<SignInPage />);
    fireEvent.change(screen.getByLabelText(/^email$/i), {
      target: { value: 'returning@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(document.cookie).not.toContain('gw_invite=STALE-CODE-0001');
    expect(document.cookie).not.toContain('gw_invite=');
  });

  it('trims surrounding whitespace before writing the cookie', () => {
    render(<SignInPage />);
    fireEvent.change(inviteInput(), { target: { value: '  K7QD-2M9V-XBTR  ' } });
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));
    expect(document.cookie).toContain('gw_invite=K7QD-2M9V-XBTR');
  });
});
