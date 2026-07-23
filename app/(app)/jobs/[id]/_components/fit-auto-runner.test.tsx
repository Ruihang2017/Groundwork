// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import FitAutoRunner from '@/app/(app)/jobs/[id]/_components/fit-auto-runner';
import { FIT_DISCLAIMER } from '@/app/(app)/jobs/[id]/_components/composite-score-banner';
import { PARTIAL_DROPPED_NOTE } from '@/app/(app)/jobs/[id]/_components/dropped-count-header';
import { fitResponseFixture, jobFixture } from '@/app/(app)/jobs/_fixtures/job-fixtures';

// HONESTY NOTE: this file proves the two-call wiring, the single-flight guard and
// every branch of FIT-02's wire contract. It proves nothing about the CONTENT of the
// report — every fit/ledger here is a fixture this repo wrote.

afterEach(cleanup);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const JOB_ID = 'job-1';

type Reply = { status: number; body?: unknown };

/** Queues replies in call order; extra calls reuse the last one. */
function stubFetch(...replies: Reply[]) {
  let call = 0;
  const fetchMock = vi.fn().mockImplementation(async () => {
    const reply = replies[Math.min(call, replies.length - 1)];
    call += 1;
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body ?? {},
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('FitAutoRunner — the automatic second call (FIT-03 Deliverable 7; plan D3/D9)', () => {
  it('[machine] fires exactly ONE POST on mount, with no body and no Content-Type', async () => {
    const fetchMock = stubFetch({ status: 200, body: fitResponseFixture() });
    render(<FitAutoRunner jobId={JOB_ID} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // FIT-02's route reads NO request body at all.
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/job-1/fit', { method: 'POST' });
  });

  it('[machine] shows the role="status" loading copy while in flight, and drops it after', async () => {
    stubFetch({ status: 200, body: fitResponseFixture() });
    render(<FitAutoRunner jobId={JOB_ID} />);

    // PRD §5.1's real p50 budget, honestly stated — streaming is NOT implemented
    // (plan §5 Q5).
    expect(screen.getByRole('status').textContent).toMatch(/about 30 seconds/i);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('[machine] D9: re-rendering the same element does NOT issue a second POST', async () => {
    // The ref guard is load-bearing in dev: next.config.mjs is empty, so
    // reactStrictMode defaults to true and every effect mounts twice.
    const fetchMock = stubFetch({ status: 200, body: fitResponseFixture() });
    const { rerender } = render(<FitAutoRunner jobId={JOB_ID} />);
    rerender(<FitAutoRunner jobId={JOB_ID} />);
    rerender(<FitAutoRunner jobId={JOB_ID} />);

    await waitFor(() => expect(screen.getByText(FIT_DISCLAIMER)).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('[machine] 200 renders the full report INCLUDING the fresh dropped payload, with NO partial note', async () => {
    // D4: `dropped.bindings` exists ONLY in this response and is never persisted, so
    // this is the one render that can satisfy PRD §5.5 layer 1 in full.
    stubFetch({ status: 200, body: fitResponseFixture() });
    render(<FitAutoRunner jobId={JOB_ID} />);

    await waitFor(() => expect(screen.getByText(FIT_DISCLAIMER)).toBeTruthy());
    expect(screen.getByText('2 items were dropped')).toBeTruthy();
    expect(screen.queryByText(PARTIAL_DROPPED_NOTE)).toBeNull();

    fireEvent.click(screen.getByText(/show the dropped entries/i));
    expect(screen.getByText(/project-that-does-not-exist/)).toBeTruthy();

    // The report itself.
    expect(screen.getByText('58 / 100')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /hard requirements/i })).toBeTruthy();
  });
});

describe('FitAutoRunner — 409 already_fitted is NOT an error (plan D10)', () => {
  it('[machine] recovers via GET /api/jobs/<id> and renders the report with the PARTIAL note', async () => {
    const fetchMock = stubFetch(
      { status: 409, body: { error: 'already_fitted' } },
      { status: 200, body: jobFixture() },
    );
    render(<FitAutoRunner jobId={JOB_ID} />);

    await waitFor(() => expect(screen.getByText(FIT_DISCLAIMER)).toBeTruthy());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/jobs/job-1');
    // No error was ever shown: the user's Fit exists, and saying "something went
    // wrong" while the report sits in the database would be a false failure.
    expect(screen.queryByRole('alert')).toBeNull();
    // D8: only layer 2's injections survived, so the count shrinks and says so.
    expect(screen.getByText('1 item was dropped')).toBeTruthy();
    expect(screen.getByText(PARTIAL_DROPPED_NOTE)).toBeTruthy();
  });

  it('[machine] a FAILING recovery GET falls back to the error state', async () => {
    stubFetch(
      { status: 409, body: { error: 'already_fitted' } },
      { status: 500, body: { error: 'job_read_failed' } },
    );
    render(<FitAutoRunner jobId={JOB_ID} />);

    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('[machine] branches on the ERROR STRING, not the status code — 409 no_library IS an error', async () => {
    // FIT-02 returns TWO distinct 409s and its header mandates this distinction.
    stubFetch({ status: 409, body: { error: 'no_library' } });
    render(<FitAutoRunner jobId={JOB_ID} />);

    expect((await screen.findByRole('alert')).textContent).toMatch(/library is empty/i);
    expect(screen.getByRole('link', { name: /import your resume/i }).getAttribute('href')).toBe(
      '/library',
    );
  });
});

describe('FitAutoRunner — the remaining failure branches', () => {
  it.each([
    { status: 401, body: { error: 'Unauthorized' }, match: /session has expired/i },
    { status: 404, body: { error: 'not_found' }, match: /could not find that job/i },
    { status: 422, body: { error: 'cross_failed' }, match: /could not finish screening/i },
    { status: 503, body: { error: 'global_breaker_tripped' }, match: /temporarily unavailable/i },
    { status: 500, body: { error: 'score_failed' }, match: /could not produce your fit report/i },
  ])('[machine] $status renders its own message plus a "Try again" button', async ({ status, body, match }) => {
    stubFetch({ status, body });
    render(<FitAutoRunner jobId={JOB_ID} />);

    expect((await screen.findByRole('alert')).textContent).toMatch(match);
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });

  it('[machine] a network throw renders an error and a "Try again" button', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    render(<FitAutoRunner jobId={JOB_ID} />);

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not reach the server/i);
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });

  it('[machine] a 200 whose body fails the schema is an ERROR, never a half-rendered report', async () => {
    stubFetch({ status: 200, body: { jd: { nonsense: true }, ledger: null, fit: null } });
    render(<FitAutoRunner jobId={JOB_ID} />);

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(FIT_DISCLAIMER)).toBeNull();
    expect(screen.queryByRole('heading', { name: /hard requirements/i })).toBeNull();
  });
});

describe('FitAutoRunner — the manual retry (plan D9: explicit user action only)', () => {
  it('[machine] clicking "Try again" issues exactly ONE more POST', async () => {
    const fetchMock = stubFetch(
      { status: 503, body: { error: 'global_breaker_tripped' } },
      { status: 200, body: fitResponseFixture() },
    );
    render(<FitAutoRunner jobId={JOB_ID} />);

    await screen.findByRole('alert');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(screen.getByText(FIT_DISCLAIMER)).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]).toEqual(['/api/jobs/job-1/fit', { method: 'POST' }]);
  });

  it('[machine] the retry control is UNREACHABLE while a call is in flight', async () => {
    // The error UI is replaced by the role="status" line during the call, so there is
    // no button to double-click. The `inFlight` ref is the second layer beneath that.
    let resolveSecond: (value: unknown) => void = () => {};
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
      }
      return new Promise((resolve) => {
        resolveSecond = resolve;
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<FitAutoRunner jobId={JOB_ID} />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveSecond({ ok: true, status: 200, json: async () => fitResponseFixture() });
    await waitFor(() => expect(screen.getByText(FIT_DISCLAIMER)).toBeTruthy());
  });

  it('[machine] NO automatic retry: a failure issues exactly one call and then waits', async () => {
    // An automatic retry would be a second PAID CROSS call from a component the user
    // may not be watching (plan D9).
    const fetchMock = stubFetch({ status: 422, body: { error: 'cross_failed' } });
    render(<FitAutoRunner jobId={JOB_ID} />);

    await screen.findByRole('alert');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('FitAutoRunner — privacy (PRD §8.1)', () => {
  it('[machine] never logs — the response carries the JD-derived ledger and library evidence', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    stubFetch({ status: 500, body: { error: 'score_failed' } });
    render(<FitAutoRunner jobId={JOB_ID} />);
    await screen.findByRole('alert');

    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('[machine] persists nothing to browser storage', async () => {
    stubFetch({ status: 200, body: fitResponseFixture() });
    render(<FitAutoRunner jobId={JOB_ID} />);
    await waitFor(() => expect(screen.getByText(FIT_DISCLAIMER)).toBeTruthy());

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
  });
});
