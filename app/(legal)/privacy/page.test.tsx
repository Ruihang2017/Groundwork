// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import PrivacyPolicyPage from '@/app/(legal)/privacy/page';

// @testing-library/react's auto-cleanup only self-registers under vitest
// `globals: true`, which this repo does NOT enable — so clean up explicitly
// (same pattern as app/(auth)/signin/page.test.tsx).
afterEach(cleanup);

describe('PrivacyPolicyPage (PLT-01 Deliverable 1)', () => {
  it('renders without throwing and shows a recognizable heading', () => {
    render(<PrivacyPolicyPage />);
    expect(
      screen.getByRole('heading', { name: /privacy policy/i, level: 1 }),
    ).toBeTruthy();
  });

  it('states the load-bearing, honest data claims (PRD §8.3)', () => {
    const { container } = render(<PrivacyPolicyPage />);
    // "Anthropic" appears more than once (a <strong> plus surrounding prose), so
    // assert against the full rendered text rather than a single element.
    expect(container.textContent).toMatch(/anthropic/i);
    // Anthropic named as the only third-party processor.
    expect(container.textContent).toMatch(/only third-party processor/i);
    // Hard, irreversible account deletion.
    expect(container.textContent).toMatch(/irreversible/i);
    // No third-party analytics.
    expect(container.textContent).toMatch(/do not integrate any third-party analytics/i);
  });

  it('renders no user-specific / session-derived content (public page)', () => {
    // A public legal page is a static Server Component with no auth() call; the
    // rendered output must not leak a user email/name. Guard against a future
    // edit that accidentally makes it dynamic.
    const { container } = render(<PrivacyPolicyPage />);
    expect(container.textContent).not.toMatch(/@example\.com/);
  });
});
