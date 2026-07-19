// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

import DeleteAccountConfirm from '@/app/(app)/settings/_components/delete-account-confirm';

// Explicit cleanup — no vitest globals in this repo (see signin page test).
afterEach(cleanup);

// The success path sets window.location.href, which jsdom would treat as a real
// navigation. Replace location with a plain, writable object so the component can
// set .href without a jsdom "navigation not implemented" error — and so we can
// assert the target.
const originalLocation = window.location;
beforeAll(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { href: '' },
  });
});
afterAll(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: originalLocation,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  window.location.href = '';
});

const revealButton = () => screen.getByRole('button', { name: /^delete my account$/i });
const destructiveButton = () =>
  screen.getByRole('button', { name: /permanently delete my account/i });

describe('DeleteAccountConfirm (PLT-01 Deliverable 3)', () => {
  it('gates the destructive action behind a reveal step (no confirm UI up front)', () => {
    render(<DeleteAccountConfirm />);
    expect(revealButton()).toBeTruthy();
    // The confirmation input and destructive button are not present yet.
    expect(screen.queryByLabelText(/type .* to confirm/i)).toBeNull();
    expect(
      screen.queryByRole('button', { name: /permanently delete my account/i }),
    ).toBeNull();
  });

  it('revealing shows the confirmation input and a DISABLED destructive button', () => {
    render(<DeleteAccountConfirm />);
    fireEvent.click(revealButton());
    expect(screen.getByLabelText(/type .* to confirm/i)).toBeTruthy();
    expect((destructiveButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables the destructive button only once the exact phrase is typed', () => {
    render(<DeleteAccountConfirm />);
    fireEvent.click(revealButton());
    const input = screen.getByLabelText(/type .* to confirm/i);

    fireEvent.change(input, { target: { value: 'delete' } }); // wrong case
    expect((destructiveButton() as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'DELETE' } });
    expect((destructiveButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it('POSTs to /api/account/delete (no userId in the request) and navigates home on success', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ deleted: true }) });
    vi.stubGlobal('fetch', fetchMock);

    render(<DeleteAccountConfirm />);
    fireEvent.click(revealButton());
    fireEvent.change(screen.getByLabelText(/type .* to confirm/i), {
      target: { value: 'DELETE' },
    });
    fireEvent.click(destructiveButton());

    // Called with exactly method POST and NO body (the route derives userId from
    // the session — the client never sends one).
    expect(fetchMock).toHaveBeenCalledWith('/api/account/delete', {
      method: 'POST',
    });
    await waitFor(() => expect(window.location.href).toBe('/'));
  });

  it('shows an inline error and does NOT navigate when the delete fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, json: async () => ({ error: 'boom' }) });
    vi.stubGlobal('fetch', fetchMock);

    render(<DeleteAccountConfirm />);
    fireEvent.click(revealButton());
    fireEvent.change(screen.getByLabelText(/type .* to confirm/i), {
      target: { value: 'DELETE' },
    });
    fireEvent.click(destructiveButton());

    expect(await screen.findByText(/account deletion failed/i)).toBeTruthy();
    expect(window.location.href).toBe('');
  });
});
