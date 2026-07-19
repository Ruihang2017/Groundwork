// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import SettingsPage from '@/app/(app)/settings/page';

// Explicit cleanup — no vitest globals in this repo (see signin page test).
afterEach(cleanup);

describe('SettingsPage (PLT-01 Deliverable 3)', () => {
  it('renders the settings heading and hosts the delete-account action', () => {
    render(<SettingsPage />);
    expect(
      screen.getByRole('heading', { name: /account settings/i, level: 1 }),
    ).toBeTruthy();
    // The (gated) delete action is present on the page.
    expect(
      screen.getByRole('button', { name: /^delete my account$/i }),
    ).toBeTruthy();
  });
});
