// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import TailorGenerator from '@/app/(app)/jobs/[id]/resume/_components/tailor-generator';
import {
  LIBRARY_FIXTURE,
  tailorResponseFixture,
} from '@/app/(app)/jobs/[id]/resume/_fixtures/tailored-fixtures';
import { projectNameMap } from '@/app/(app)/jobs/[id]/resume/_lib/project-names';

// TLR-02 D4 + TLR-01 wire contract (plan §4 "additional tests"). Click-triggered (never
// auto-on-mount); single-flight; defensive parse; every error branch actionable.

afterEach(cleanup);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const PROJECT_NAMES = projectNameMap(LIBRARY_FIXTURE);

function renderGenerator() {
  return render(<TailorGenerator jobId="job-1" projectNames={PROJECT_NAMES} />);
}

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const generateButton = () => screen.getByRole('button', { name: /generate tailored resume/i });

describe('TailorGenerator — D4: click-triggered, never on mount', () => {
  it('[machine] issues NO fetch on mount', async () => {
    const fetchMock = stubFetch(200, tailorResponseFixture());
    renderGenerator();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('[machine] clicking POSTs /api/jobs/<id>/tailor with { method: "POST" } and NO body/Content-Type', async () => {
    const fetchMock = stubFetch(200, tailorResponseFixture());
    renderGenerator();
    fireEvent.click(generateButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/jobs/job-1/tailor');
    // Exactly { method: 'POST' } — the route reads no body and no Content-Type.
    expect(init).toEqual({ method: 'POST' });
  });

  it('[machine] double-clicking issues exactly ONE fetch (single-flight)', () => {
    let resolveFetch: (value: unknown) => void = () => {};
    const fetchMock = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderGenerator();
    fireEvent.click(generateButton());
    fireEvent.click(generateButton());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch({ ok: true, status: 200, json: async () => tailorResponseFixture() });
  });
});

describe('TailorGenerator — 200 renders the workspace', () => {
  it('[machine] renders alignment, edits and the dropped list from the response body', async () => {
    stubFetch(200, tailorResponseFixture());
    renderGenerator();
    fireEvent.click(generateButton());

    // Alignment table.
    expect(await screen.findByText('Present')).toBeTruthy();
    expect(
      screen.getByText(/gap — not in your library, and never written into your resume/i),
    ).toBeTruthy();
    // Edits (one checkbox per edit).
    expect(screen.getAllByRole('checkbox').length).toBe(tailorResponseFixture().edits.length);
    // Dropped header from the response (count = 2).
    expect(screen.getByText('2 items were dropped')).toBeTruthy();
    // The editor is seeded.
    expect(screen.getByLabelText(/full draft \(markdown\)/i)).toBeTruthy();
  });

  it('[machine] a malformed 200 body shows the generic error, never a half-rendered draft', async () => {
    stubFetch(200, { not: 'a tailored resume' });
    renderGenerator();
    fireEvent.click(generateButton());

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not produce a tailored draft/i);
    expect(screen.queryByLabelText(/full draft/i)).toBeNull();
  });
});

describe('TailorGenerator — every error branch keys on the error STRING', () => {
  it('[machine] 409 fit_not_ready tells the user to run Fit first, with a link', async () => {
    stubFetch(409, { error: 'fit_not_ready' });
    renderGenerator();
    fireEvent.click(generateButton());

    expect((await screen.findByRole('alert')).textContent).toMatch(/run the fit report/i);
    expect(screen.getByRole('link', { name: /go to the fit report/i }).getAttribute('href')).toBe(
      '/jobs/job-1',
    );
    expect((generateButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it('[machine] 409 no_library shows the import CTA', async () => {
    stubFetch(409, { error: 'no_library' });
    renderGenerator();
    fireEvent.click(generateButton());

    await screen.findByRole('alert');
    expect(screen.getByRole('link', { name: /import your resume/i }).getAttribute('href')).toBe('/library');
  });

  it('[machine] 429 quota_exceeded shows the allowance message and NO raw resetAt epoch', async () => {
    stubFetch(429, { error: 'quota_exceeded', op: 'tailor', resetAt: 1893456000000 });
    renderGenerator();
    fireEvent.click(generateButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/today's tailor allowance/i);
    expect(alert.textContent).not.toContain('1893456000000');
  });

  it('[machine] 422 tailor_failed shows a retry message', async () => {
    stubFetch(422, { error: 'tailor_failed' });
    renderGenerator();
    fireEvent.click(generateButton());
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not produce a tailored draft/i);
  });

  it('[machine] 401 says the session expired', async () => {
    stubFetch(401, { error: 'Unauthorized' });
    renderGenerator();
    fireEvent.click(generateButton());
    expect((await screen.findByRole('alert')).textContent).toMatch(/session has expired/i);
  });

  it('[machine] 404 says not found', async () => {
    stubFetch(404, { error: 'not_found' });
    renderGenerator();
    fireEvent.click(generateButton());
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not find that job/i);
  });

  it('[machine] 503 says temporarily unavailable', async () => {
    stubFetch(503, { error: 'global_breaker_tripped' });
    renderGenerator();
    fireEvent.click(generateButton());
    expect((await screen.findByRole('alert')).textContent).toMatch(/temporarily unavailable/i);
  });

  it('[machine] a network throw shows a reach-the-server message and leaves the button usable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    renderGenerator();
    fireEvent.click(generateButton());

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not reach the server/i);
    expect((generateButton() as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('TailorGenerator — privacy', () => {
  it('[machine] never logs the response (résumé/alignment/edit content is PII)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    stubFetch(200, tailorResponseFixture());
    renderGenerator();
    fireEvent.click(generateButton());
    await screen.findByText('Present');

    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
