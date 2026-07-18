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
