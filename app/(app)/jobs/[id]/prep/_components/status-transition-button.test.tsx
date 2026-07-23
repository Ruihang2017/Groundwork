// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import StatusTransitionButton from '@/app/(app)/jobs/[id]/prep/_components/status-transition-button';

// PRP-03 acceptance item 2 — PATCHes /api/jobs/<id> with EXACTLY { status: 'interviewing' },
// single-flight, and on 200 calls the App Router's refresh() (plan §2.3, §3). Mirrors
// mark-applied-button.test.tsx exactly, plus the router-refresh assertions.
//
// R3 — the repo's FIRST useRouter use: under real jsdom with no App Router provider,
// useRouter() THROWS "invariant expected app router to be mounted", so next/navigation MUST
// be mocked. The mock's refresh() is the assertable success signal.

const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));

afterEach(cleanup);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
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

const button = () => screen.getByRole('button', { name: /i got the interview/i });

describe('StatusTransitionButton (PRP-03 acceptance item 2)', () => {
  it('[machine] PATCHes /api/jobs/<id> with exactly { status: "interviewing" } as JSON', async () => {
    const fetchMock = stubFetch(200);
    render(<StatusTransitionButton jobId={JOB_ID} />);
    fireEvent.click(button());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/jobs/job-1');
    expect(init.method).toBe('PATCH');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });

    const body = JSON.parse(init.body);
    expect(body).toEqual({ status: 'interviewing' });
    // Exactly one key — nothing else smuggled in.
    expect(Object.keys(body)).toEqual(['status']);
  });

  it('[machine] on 200 refreshes the route and disables the button', async () => {
    stubFetch(200);
    render(<StatusTransitionButton jobId={JOB_ID} />);
    fireEvent.click(button());

    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByRole('status').textContent).toMatch(/unlocking/i);
  });

  it('[machine] COST/idempotency: double-clicking issues exactly ONE fetch', () => {
    let resolveFetch: (value: unknown) => void = () => {};
    const fetchMock = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<StatusTransitionButton jobId={JOB_ID} />);
    fireEvent.click(button());
    fireEvent.click(button());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch({ ok: true, status: 200, json: async () => ({}) });
  });

  it('[machine] 401 shows the session-expired alert, leaves the button usable, does NOT refresh', async () => {
    stubFetch(401, { error: 'Unauthorized' });
    render(<StatusTransitionButton jobId={JOB_ID} />);
    fireEvent.click(button());

    expect((await screen.findByRole('alert')).textContent).toMatch(/session has expired/i);
    expect((button() as HTMLButtonElement).disabled).toBe(false);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('[machine] 404 shows a not-found alert, leaves the button usable, does NOT refresh', async () => {
    stubFetch(404, { error: 'not_found' });
    render(<StatusTransitionButton jobId={JOB_ID} />);
    fireEvent.click(button());

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not find that job/i);
    expect((button() as HTMLButtonElement).disabled).toBe(false);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('[machine] a 500 shows a generic retry alert, leaves the button usable, does NOT refresh', async () => {
    stubFetch(500, { error: 'job_write_failed' });
    render(<StatusTransitionButton jobId={JOB_ID} />);
    fireEvent.click(button());

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not update this job/i);
    expect((button() as HTMLButtonElement).disabled).toBe(false);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('[machine] a network throw shows a reach-the-server alert and does NOT refresh', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    render(<StatusTransitionButton jobId={JOB_ID} />);
    fireEvent.click(button());

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not reach the server/i);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('[machine] PRIVACY: never logs (a status change is private application activity)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    stubFetch(500, { error: 'job_write_failed' });
    render(<StatusTransitionButton jobId={JOB_ID} />);
    fireEvent.click(button());
    await screen.findByRole('alert');

    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
