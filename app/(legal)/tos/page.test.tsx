// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import TermsOfServicePage from '@/app/(legal)/tos/page';

// Explicit cleanup — see app/(legal)/privacy/page.test.tsx for why (no vitest
// globals in this repo).
afterEach(cleanup);

describe('TermsOfServicePage (PLT-01 Deliverable 1)', () => {
  it('renders without throwing and shows a recognizable heading', () => {
    render(<TermsOfServicePage />);
    expect(
      screen.getByRole('heading', { name: /terms of service/i, level: 1 }),
    ).toBeTruthy();
  });

  it('points to the same hard-delete mechanism as a termination path', () => {
    render(<TermsOfServicePage />);
    expect(screen.getByText(/termination and deletion/i)).toBeTruthy();
  });

  it('renders no user-specific / session-derived content (public page)', () => {
    const { container } = render(<TermsOfServicePage />);
    expect(container.textContent).not.toMatch(/@example\.com/);
  });
});
