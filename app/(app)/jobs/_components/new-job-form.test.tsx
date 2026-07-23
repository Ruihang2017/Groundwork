// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import NewJobForm from '@/app/(app)/jobs/_components/new-job-form';

// HONESTY NOTE: this file proves the gate, the caps, the single-flight and every
// error branch of FIT-01's wire contract. It proves nothing about READ's output
// quality — that is `pnpm eval`'s Q1.

afterEach(cleanup);

// The 201 path sets window.location.href, which jsdom would treat as a real
// navigation. Same Object.defineProperty stub as
// settings/_components/delete-account-confirm.test.tsx.
const originalLocation = window.location;
beforeAll(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { href: '' },
  });
});
afterAll(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.location.href = '';
});

function stubFetch(response: { status: number; body?: unknown }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    json: async () => response.body ?? {},
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function fillForm({
  company = 'Northwind',
  role = 'Staff Engineer',
  jdRaw = 'We are hiring a staff engineer to run our payments platform.',
} = {}) {
  fireEvent.change(screen.getByLabelText(/company/i), { target: { value: company } });
  fireEvent.change(screen.getByLabelText(/^role$/i), { target: { value: role } });
  fireEvent.change(screen.getByLabelText(/job description/i), { target: { value: jdRaw } });
}

const submit = () => screen.getByRole('button', { name: /screen this job/i });

describe('NewJobForm — the no-library gate (FIT-03 acceptance item 1; PRD §5.7)', () => {
  it('[machine] hasLibrary=false renders the import CTA and NO usable form', () => {
    render(<NewJobForm hasLibrary={false} />);

    const link = screen.getByRole('link', { name: /import your resume/i });
    expect(link.getAttribute('href')).toBe('/library');
    // There is no form to submit at all — not a disabled one.
    expect(screen.queryByRole('button', { name: /screen this job/i })).toBeNull();
    expect(screen.queryByLabelText(/job description/i)).toBeNull();
    // PRD's reasoning, in the product's voice.
    expect(screen.getByText(/empty library produces generic output/i)).toBeTruthy();
  });

  it('[machine] hasLibrary=false makes fetch UNREACHABLE — zero calls, whatever the user does', () => {
    const fetchMock = stubFetch({ status: 201 });
    const { container } = render(<NewJobForm hasLibrary={false} />);

    // There is no form element to submit; firing one anyway must change nothing.
    const form = container.querySelector('form');
    expect(form).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('[machine] hasLibrary=true renders all three labelled fields', () => {
    render(<NewJobForm hasLibrary />);
    expect(screen.getByLabelText(/company/i)).toBeTruthy();
    expect(screen.getByLabelText(/^role$/i)).toBeTruthy();
    expect(screen.getByLabelText(/job description/i)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /import your resume/i })).toBeNull();
  });
});

describe('NewJobForm — the happy path (plan D3)', () => {
  it('[machine] POSTs exactly { jdRaw, company, role } as JSON — never a userId', async () => {
    const fetchMock = stubFetch({ status: 201, body: { id: 'job-9' } });
    render(<NewJobForm hasLibrary />);
    fillForm();
    fireEvent.click(submit());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/jobs');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });

    const body = JSON.parse(init.body);
    expect(Object.keys(body).sort()).toEqual(['company', 'jdRaw', 'role']);
    expect(body).toMatchObject({ company: 'Northwind', role: 'Staff Engineer' });
    // The route derives userId from the session (PRD §8.3); the client never sends one.
    expect(body.userId).toBeUndefined();
  });

  it('[machine] 201 navigates to /jobs/<id> with a FULL page load (D3)', async () => {
    stubFetch({ status: 201, body: { id: 'job-9' } });
    render(<NewJobForm hasLibrary />);
    fillForm();
    fireEvent.click(submit());

    await waitFor(() => expect(window.location.href).toBe('/jobs/job-9'));
  });

  it('[machine] 201 with NO id shows an error and does NOT navigate to /jobs/undefined', async () => {
    stubFetch({ status: 201, body: {} });
    render(<NewJobForm hasLibrary />);
    fillForm();
    fireEvent.click(submit());

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(window.location.href).toBe('');
  });

  it('[machine] COST CONTROL: double-clicking submit issues exactly ONE fetch', async () => {
    // One submit is one paid READ call plus one `fit` quota unit (~$0.04, PRD §9).
    // A disabled button is not a guarantee — both clicks can dispatch before React
    // re-renders, which is why the handler ALSO returns early on `busy`.
    let resolveFetch: (value: unknown) => void = () => {};
    const fetchMock = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<NewJobForm hasLibrary />);
    fillForm();
    fireEvent.click(submit());
    fireEvent.click(submit());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch({ ok: true, status: 201, json: async () => ({ id: 'job-9' }) });
    await waitFor(() => expect(window.location.href).toBe('/jobs/job-9'));
  });
});

describe('NewJobForm — client-side pre-checks bail with ZERO fetch calls', () => {
  it.each([
    { name: 'empty company', values: { company: '' } },
    { name: 'whitespace-only role', values: { role: '   ' } },
    { name: 'empty job description', values: { jdRaw: '' } },
  ])('[machine] $name → role="alert" and no fetch', async ({ values }) => {
    const fetchMock = stubFetch({ status: 201, body: { id: 'x' } });
    render(<NewJobForm hasLibrary />);
    fillForm(values);
    fireEvent.click(submit());

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('[machine] an over-cap job description → role="alert" and no fetch', async () => {
    const fetchMock = stubFetch({ status: 201, body: { id: 'x' } });
    render(<NewJobForm hasLibrary />);
    fillForm({ jdRaw: 'x'.repeat(50_001) });
    fireEvent.click(submit());

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('[machine] an over-cap company → role="alert" and no fetch', async () => {
    const fetchMock = stubFetch({ status: 201, body: { id: 'x' } });
    render(<NewJobForm hasLibrary />);
    fillForm({ company: 'c'.repeat(201) });
    fireEvent.click(submit());

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('NewJobForm — every non-201 branch of FIT-01s wire contract', () => {
  it('[machine] 403 no_library flips to the import CTA (a stale prop is not a boundary)', async () => {
    stubFetch({ status: 403, body: { error: 'no_library' } });
    render(<NewJobForm hasLibrary />);
    fillForm();
    fireEvent.click(submit());

    const link = await screen.findByRole('link', { name: /import your resume/i });
    expect(link.getAttribute('href')).toBe('/library');
  });

  it('[machine] 429 quota_exceeded shows the allowance message and NO raw resetAt epoch', async () => {
    stubFetch({ status: 429, body: { error: 'quota_exceeded', op: 'fit', resetAt: 1893456000000 } });
    render(<NewJobForm hasLibrary />);
    fillForm();
    fireEvent.click(submit());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/today's Fit allowance/i);
    expect(alert.textContent).not.toContain('1893456000000');
  });

  it('[machine] 422 read_failed tells the user what to check', async () => {
    stubFetch({ status: 422, body: { error: 'read_failed' } });
    render(<NewJobForm hasLibrary />);
    fillForm();
    fireEvent.click(submit());

    expect((await screen.findByRole('alert')).textContent).toMatch(/pasted the whole posting/i);
  });

  it('[machine] 400 surfaces the Zod issue PATHS (never values), capped at 5', async () => {
    stubFetch({
      status: 400,
      body: {
        error: 'invalid_body',
        issues: ['jdRaw: too small', 'company: required', 'a', 'b', 'c', 'SIXTH-SHOULD-NOT-SHOW'],
      },
    });
    render(<NewJobForm hasLibrary />);
    fillForm();
    fireEvent.click(submit());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('jdRaw: too small');
    expect(alert.textContent).not.toContain('SIXTH-SHOULD-NOT-SHOW');
  });

  it('[machine] 401 says the session expired', async () => {
    stubFetch({ status: 401, body: { error: 'Unauthorized' } });
    render(<NewJobForm hasLibrary />);
    fillForm();
    fireEvent.click(submit());

    expect((await screen.findByRole('alert')).textContent).toMatch(/session has expired/i);
  });

  it('[machine] 503 says temporarily unavailable', async () => {
    stubFetch({ status: 503, body: { error: 'global_breaker_tripped' } });
    render(<NewJobForm hasLibrary />);
    fillForm();
    fireEvent.click(submit());

    expect((await screen.findByRole('alert')).textContent).toMatch(/temporarily unavailable/i);
  });

  it('[machine] a network throw shows one generic message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    render(<NewJobForm hasLibrary />);
    fillForm();
    fireEvent.click(submit());

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not reach the server/i);
  });

  it('[machine] after an error the form stays USABLE and the typed values survive', async () => {
    // Losing a pasted job description to a transient error is a real user injury.
    stubFetch({ status: 500, body: { error: 'job_write_failed' } });
    render(<NewJobForm hasLibrary />);
    fillForm({ jdRaw: 'A very long posting the user does not want to re-paste.' });
    fireEvent.click(submit());

    await screen.findByRole('alert');
    expect((submit() as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText(/company/i) as HTMLInputElement).value).toBe('Northwind');
    expect((screen.getByLabelText(/job description/i) as HTMLTextAreaElement).value).toBe(
      'A very long posting the user does not want to re-paste.',
    );
  });
});

describe('NewJobForm — privacy', () => {
  it('[machine] NEVER logs: a pasted JD carries the user own annotations', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    stubFetch({ status: 500, body: { error: 'job_write_failed' } });
    render(<NewJobForm hasLibrary />);
    fillForm();
    fireEvent.click(submit());
    await screen.findByRole('alert');

    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
