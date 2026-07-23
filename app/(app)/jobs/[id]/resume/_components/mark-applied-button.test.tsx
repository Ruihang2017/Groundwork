// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import MarkAppliedButton from '@/app/(app)/jobs/[id]/resume/_components/mark-applied-button';

// TLR-02 acceptance item 4 — PATCHes /api/jobs/<id> with EXACTLY { status: 'applied' },
// single-flight, confirms in place on 200, and surfaces FIT-01's error contract otherwise.

afterEach(cleanup);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const JOB_ID = 'job-1';

function stubFetch(status = 200, body: unknown = {}) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const button = () => screen.getByRole('button', { name: /mark as applied/i });

describe('MarkAppliedButton (TLR-02 acceptance item 4)', () => {
  it('[machine] PATCHes /api/jobs/<id> with exactly { status: "applied" } as JSON', async () => {
    const fetchMock = stubFetch(200);
    render(<MarkAppliedButton jobId={JOB_ID} />);
    fireEvent.click(button());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/jobs/job-1');
    expect(init.method).toBe('PATCH');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });

    const body = JSON.parse(init.body);
    expect(body).toEqual({ status: 'applied' });
    // Exactly one key — nothing else smuggled in.
    expect(Object.keys(body)).toEqual(['status']);
  });

  it('[machine] on 200 shows "Marked as applied" and disables the button (no reload, D5)', async () => {
    stubFetch(200);
    render(<MarkAppliedButton jobId={JOB_ID} />);
    fireEvent.click(button());

    expect(await screen.findByText(/marked as applied/i)).toBeTruthy();
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(true));
  });

  it('[machine] COST/idempotency: double-clicking issues exactly ONE fetch', () => {
    let resolveFetch: (value: unknown) => void = () => {};
    const fetchMock = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<MarkAppliedButton jobId={JOB_ID} />);
    fireEvent.click(button());
    fireEvent.click(button());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch({ ok: true, status: 200, json: async () => ({}) });
  });

  it('[machine] 401 shows the session-expired alert and leaves the button usable', async () => {
    stubFetch(401, { error: 'Unauthorized' });
    render(<MarkAppliedButton jobId={JOB_ID} />);
    fireEvent.click(button());

    expect((await screen.findByRole('alert')).textContent).toMatch(/session has expired/i);
    expect((button() as HTMLButtonElement).disabled).toBe(false);
  });

  it('[machine] 404 shows a not-found alert and leaves the button usable', async () => {
    stubFetch(404, { error: 'not_found' });
    render(<MarkAppliedButton jobId={JOB_ID} />);
    fireEvent.click(button());

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not find that job/i);
    expect((button() as HTMLButtonElement).disabled).toBe(false);
  });

  it('[machine] a 500 shows a generic retry alert and leaves the button usable', async () => {
    stubFetch(500, { error: 'job_write_failed' });
    render(<MarkAppliedButton jobId={JOB_ID} />);
    fireEvent.click(button());

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not update this job/i);
    expect((button() as HTMLButtonElement).disabled).toBe(false);
  });

  it('[machine] a network throw shows a reach-the-server alert', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    render(<MarkAppliedButton jobId={JOB_ID} />);
    fireEvent.click(button());

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not reach the server/i);
  });

  it('[machine] PRIVACY: never logs (a status change is private application activity)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    stubFetch(500, { error: 'job_write_failed' });
    render(<MarkAppliedButton jobId={JOB_ID} />);
    fireEvent.click(button());
    await screen.findByRole('alert');

    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
