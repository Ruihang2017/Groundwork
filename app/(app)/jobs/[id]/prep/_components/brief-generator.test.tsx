// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import BriefGenerator from '@/app/(app)/jobs/[id]/prep/_components/brief-generator';
import { RESEARCH_FAIL_COPY } from '@/app/(app)/jobs/[id]/prep/_components/research-fail-banner';
import {
  LEDGER_FIXTURE,
  LIBRARY_FIXTURE,
  REHEARSE_FIXTURE,
  rehearseResponseFixture,
  researchResponseFixture,
} from '@/app/(app)/jobs/[id]/prep/_fixtures/brief-fixtures';
import { projectNameMap } from '@/app/(app)/jobs/[id]/prep/_lib/project-names';

// PRP-04 — the load-bearing file (acceptance items 1, 2; D2/D3/D4/D5/D6). Proves the two-call
// wiring, the degrade-vs-hard-fail split, the single-flight guard, the relaxed read, and each
// branch of PRP-01/PRP-02's wire contract. It proves NOTHING about brief CONTENT — every
// fixture here is hand-written by this repo.

afterEach(cleanup);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const JOB_ID = 'job-1';
const PROJECT_NAMES = projectNameMap(LIBRARY_FIXTURE);

type Reply = { status: number; body?: unknown };

/** Queues replies in call order; extra calls reuse the last one (copied from fit-auto-runner). */
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

function renderGenerator() {
  return render(
    <BriefGenerator jobId={JOB_ID} ledger={LEDGER_FIXTURE} projectNames={PROJECT_NAMES} />,
  );
}

describe('BriefGenerator — the RESEARCH→REHEARSE orchestration (items 1, 2; D2)', () => {
  it('[machine] item 1: calls RESEARCH before REHEARSE, research is POST with no body', async () => {
    const fetchMock = stubFetch(
      { status: 200, body: researchResponseFixture() },
      { status: 200, body: rehearseResponseFixture() },
    );
    renderGenerator();

    await waitFor(() => expect(screen.getByText(REHEARSE_FIXTURE.positioning)).toBeTruthy());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/jobs/job-1/research');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/jobs/job-1/rehearse');
    // PRP-01's route reads NO body — send only { method: 'POST' }.
    expect(fetchMock.mock.calls[0][1]).toEqual({ method: 'POST' });
  });

  it('[machine] item 2: a degraded RESEARCH still calls REHEARSE with { intel: null }, and the banner renders alongside the questions', async () => {
    const fetchMock = stubFetch(
      { status: 200, body: { intel: null, failed: true } },
      { status: 200, body: rehearseResponseFixture({ intel: null }) },
    );
    renderGenerator();

    await waitFor(() => expect(screen.getByText(RESEARCH_FAIL_COPY)).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ intel: null });
    // The banner is rendered ALONGSIDE the brief, not instead of it.
    expect(screen.getByText(REHEARSE_FIXTURE.questions[0].question)).toBeTruthy();
  });

  it('[machine] D3: a successful generation renders the brief from the response, with the dropped-count header', async () => {
    stubFetch(
      { status: 200, body: researchResponseFixture() },
      { status: 200, body: rehearseResponseFixture() },
    );
    renderGenerator();

    await waitFor(() => expect(screen.getByText(REHEARSE_FIXTURE.positioning)).toBeTruthy());
    expect(screen.getByText('1 item was dropped')).toBeTruthy();
    fireEvent.click(screen.getByText(/show the dropped entries/i));
    // The dropped question's text (its label) is revealed on expand.
    expect(screen.getByText('Tell me about the ghost project you never built.')).toBeTruthy();
  });

  it('[machine] D2 cost hole: a RESEARCH 429 HARD-STOPS — REHEARSE is NEVER called, resetAt not echoed', async () => {
    const fetchMock = stubFetch({
      status: 429,
      body: { error: 'quota_exceeded', op: 'prep', resetAt: 1_893_456_000_000 },
    });
    renderGenerator();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/prep allowance/i);
    expect(alert.textContent).not.toMatch(/1893456000000/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/jobs/job-1/research');
  });

  it('[machine] a RESEARCH 409 fit_not_ready shows a Fit link and never calls REHEARSE', async () => {
    const fetchMock = stubFetch({ status: 409, body: { error: 'fit_not_ready' } });
    renderGenerator();

    expect((await screen.findByRole('alert')).textContent).toMatch(/run the fit report/i);
    expect(screen.getByRole('link', { name: /fit report/i }).getAttribute('href')).toBe(
      '/jobs/job-1',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('BriefGenerator — REHEARSE-phase failures', () => {
  it('[machine] a REHEARSE 422 shows the generic message + a Try again button, and no brief', async () => {
    stubFetch(
      { status: 200, body: researchResponseFixture() },
      { status: 422, body: { error: 'rehearse_failed' } },
    );
    renderGenerator();

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /could not prepare your interview brief/i,
    );
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
    expect(screen.queryByText(REHEARSE_FIXTURE.positioning)).toBeNull();
  });

  it('[machine] a REHEARSE 409 no_library shows a library link', async () => {
    stubFetch(
      { status: 200, body: researchResponseFixture() },
      { status: 409, body: { error: 'no_library' } },
    );
    renderGenerator();

    expect((await screen.findByRole('alert')).textContent).toMatch(/library is empty/i);
    expect(screen.getByRole('link', { name: /import your resume/i }).getAttribute('href')).toBe(
      '/library',
    );
  });

  it('[machine] a malformed REHEARSE 200 body is a generic error, never a half-rendered brief', async () => {
    stubFetch(
      { status: 200, body: researchResponseFixture() },
      { status: 200, body: { not: 'a brief' } },
    );
    renderGenerator();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(REHEARSE_FIXTURE.positioning)).toBeNull();
  });

  it('[machine] D4: a REHEARSE 200 with FEWER than 5 questions renders successfully (ADR-A read path)', async () => {
    stubFetch(
      { status: 200, body: researchResponseFixture() },
      {
        status: 200,
        body: rehearseResponseFixture({
          rehearse: { ...REHEARSE_FIXTURE, questions: REHEARSE_FIXTURE.questions.slice(0, 4) },
        }),
      },
    );
    renderGenerator();

    await waitFor(() => expect(screen.getByText(REHEARSE_FIXTURE.positioning)).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
    // The 4th question renders; the (removed) 5th does not.
    expect(screen.getByText(REHEARSE_FIXTURE.questions[3].question)).toBeTruthy();
    expect(screen.queryByText(REHEARSE_FIXTURE.questions[4].question)).toBeNull();
  });
});

describe('BriefGenerator — single-flight, retries and privacy (D5/D6/S1/S2)', () => {
  it('[machine] D6: re-rendering the same element does NOT issue a second RESEARCH', async () => {
    const fetchMock = stubFetch(
      { status: 200, body: researchResponseFixture() },
      { status: 200, body: rehearseResponseFixture() },
    );
    const { rerender } = renderGenerator();
    rerender(<BriefGenerator jobId={JOB_ID} ledger={LEDGER_FIXTURE} projectNames={PROJECT_NAMES} />);
    rerender(<BriefGenerator jobId={JOB_ID} ledger={LEDGER_FIXTURE} projectNames={PROJECT_NAMES} />);

    await waitFor(() => expect(screen.getByText(REHEARSE_FIXTURE.positioning)).toBeTruthy());
    const researchCalls = fetchMock.mock.calls.filter((c) => c[0] === '/api/jobs/job-1/research');
    expect(researchCalls).toHaveLength(1);
  });

  it('[machine] D6: a failure issues exactly one call and then WAITS (no auto-retry)', async () => {
    const fetchMock = stubFetch({ status: 429, body: { error: 'quota_exceeded' } });
    renderGenerator();

    await screen.findByRole('alert');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('[machine] research-phase retry re-runs the WHOLE sequence', async () => {
    const fetchMock = stubFetch(
      { status: 503, body: { error: 'global_breaker_tripped' } },
      { status: 200, body: researchResponseFixture() },
      { status: 200, body: rehearseResponseFixture() },
    );
    renderGenerator();

    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(screen.getByText(REHEARSE_FIXTURE.positioning)).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/jobs/job-1/research');
    expect(fetchMock.mock.calls[2][0]).toBe('/api/jobs/job-1/rehearse');
  });

  it('[machine] D5: rehearse-phase retry re-runs REHEARSE ONLY, reusing the same intel', async () => {
    const fetchMock = stubFetch(
      { status: 200, body: researchResponseFixture() },
      { status: 422, body: { error: 'rehearse_failed' } },
      { status: 200, body: rehearseResponseFixture() },
    );
    renderGenerator();

    await screen.findByRole('alert');
    expect(fetchMock).toHaveBeenCalledTimes(2); // research + failed rehearse
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(screen.getByText(REHEARSE_FIXTURE.positioning)).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(3); // NO second research
    expect(fetchMock.mock.calls[2][0]).toBe('/api/jobs/job-1/rehearse');
    // The retry's rehearse body carries the SAME intel as the first rehearse call (D5).
    expect(fetchMock.mock.calls[2][1].body).toBe(fetchMock.mock.calls[1][1].body);
  });

  it('[machine] a network throw on RESEARCH shows a reach-the-server error, and never calls REHEARSE', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('boom'));
    vi.stubGlobal('fetch', fetchMock);
    renderGenerator();

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not reach the server/i);
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('[machine] privacy (S1/S2): no console output and no browser storage after a successful generation', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    stubFetch(
      { status: 200, body: researchResponseFixture() },
      { status: 200, body: rehearseResponseFixture() },
    );
    renderGenerator();
    await waitFor(() => expect(screen.getByText(REHEARSE_FIXTURE.positioning)).toBeTruthy());

    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
  });
});
