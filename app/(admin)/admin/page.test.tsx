// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted so the mock fns keep STABLE references (the factories below run
// hoisted, before these consts would otherwise be initialised) — same pattern as
// app/api/account/delete/route.test.ts.
const { mockAuth, mockGetWeeklyCost, mockGetLatency, mockGetDropped, mockGetFunnel } = vi.hoisted(
  () => ({
    mockAuth: vi.fn(),
    mockGetWeeklyCost: vi.fn(),
    mockGetLatency: vi.fn(),
    mockGetDropped: vi.fn(),
    mockGetFunnel: vi.fn(),
  }),
);

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/db/queries/admin', () => ({
  getWeeklyCost: mockGetWeeklyCost,
  getLatencyPercentiles: mockGetLatency,
  getDroppedRate: mockGetDropped,
  getFunnelConversion: mockGetFunnel,
}));

import AdminPage from '@/app/(admin)/admin/page';

// @testing-library/react's auto-cleanup only self-registers under vitest
// `globals: true`, which this repo does NOT enable — clean up explicitly.
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  mockAuth.mockReset();
  mockGetWeeklyCost.mockReset();
  mockGetLatency.mockReset();
  mockGetDropped.mockReset();
  mockGetFunnel.mockReset();
});

const LATENCY = {
  parse: { p50: 500, p95: 1000, samples: 10 },
  read: { p50: 1200, p95: 2400, samples: 4 },
  cross: { p50: 0, p95: 0, samples: 0 }, // the em-dash case
  tailor: { p50: 200, p95: 300, samples: 3 },
  research: { p50: 0, p95: 0, samples: 0 },
  rehearse: { p50: 0, p95: 0, samples: 0 },
};

function seedQueries() {
  mockGetWeeklyCost.mockResolvedValue(1.2345);
  mockGetLatency.mockResolvedValue(LATENCY);
  mockGetDropped.mockResolvedValue(0.75);
  mockGetFunnel.mockResolvedValue({
    signupToLibrary: 0.25,
    fitToTailor: 0.5,
    interviewingToBrief: 0.6,
  });
}

function expectNoQueryRan() {
  expect(mockGetWeeklyCost).not.toHaveBeenCalled();
  expect(mockGetLatency).not.toHaveBeenCalled();
  expect(mockGetDropped).not.toHaveBeenCalled();
  expect(mockGetFunnel).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.stubEnv('ADMIN_EMAILS', 'admin@example.com');
});

describe('AdminPage — rendering for an allowlisted admin', () => {
  it('[machine] renders all four aggregate views', async () => {
    seedQueries();
    mockAuth.mockResolvedValue({ user: { id: 'u1', email: 'admin@example.com' } });

    const { container } = render(await AdminPage());

    expect(screen.getByRole('heading', { level: 1, name: /admin observability/i })).toBeTruthy();

    // 1. weekly cost — four decimals (PRD §9 costs are ~$0.01–$0.30, so two
    //    decimals would render a real early week as $0.00).
    expect(container.textContent).toContain('$1.2345');

    // 2. latency: a row per op, with an em dash (never "0") for a zero-sample op.
    const parseRow = screen.getByRole('row', { name: /^parse/ });
    expect(parseRow.textContent).toContain('500');
    expect(parseRow.textContent).toContain('1000');
    const crossRow = screen.getByRole('row', { name: /^cross/ });
    expect(crossRow.textContent).toContain('—');
    expect(crossRow.textContent).not.toMatch(/\b0\b.*\b0\b/);

    // 3. dropped items per operation — a raw number, explicitly NOT a percentage.
    expect(container.textContent).toContain('0.75');
    expect(container.textContent).not.toContain('75.0%');
    expect(container.textContent).toMatch(/not a percentage/i);

    // 4. funnel: three ratios plus their PRD §7 targets.
    expect(container.textContent).toContain('25.0%');
    expect(container.textContent).toContain('50.0%');
    expect(container.textContent).toContain('60.0%');
    expect(container.textContent).toContain('≥ 50%');
    expect(container.textContent).toContain('≥ 25%');
    expect(container.textContent).toContain('≥ 60%');
  });

  it('[machine] labels the windows honestly (7-day vs all-time) and warns about the stage vocabulary', async () => {
    seedQueries();
    mockAuth.mockResolvedValue({ user: { id: 'u1', email: 'admin@example.com' } });

    const { container } = render(await AdminPage());

    expect(container.textContent).toMatch(/last 7 days/i);
    expect(container.textContent).toMatch(/all time/i);
    // The pipeline-stage vs user-facing-action vocabulary warning (PRD §7 budgets
    // are not comparable to an op's p50).
    expect(container.textContent).toMatch(/pipeline stages/i);
  });

  it('[machine] renders no email address or other identifying data (aggregates only, R6)', async () => {
    seedQueries();
    mockAuth.mockResolvedValue({ user: { id: 'u1', email: 'admin@example.com' } });

    const { container } = render(await AdminPage());
    expect(container.textContent).not.toMatch(/@example\.com/);
    expect(container.textContent).not.toContain('u1');
  });
});

describe('AdminPage — the gate runs BEFORE any data access (security)', () => {
  it('[machine] rejects a signed-in NON-allowlisted email and runs no query', async () => {
    seedQueries();
    mockAuth.mockResolvedValue({ user: { id: 'u2', email: 'nobody@example.com' } });

    await expect(AdminPage()).rejects.toThrow();
    // This assertion is the point of the test: it proves the gate precedes data
    // access, so a non-admin who reaches the RSC gets no aggregate byte.
    expectNoQueryRan();
  });

  it('[machine] rejects when there is no session at all and runs no query', async () => {
    seedQueries();
    mockAuth.mockResolvedValue(null);

    await expect(AdminPage()).rejects.toThrow();
    expectNoQueryRan();
  });

  it('[machine] rejects when the session has no email and runs no query', async () => {
    seedQueries();
    mockAuth.mockResolvedValue({ user: { id: 'u3', email: null } });

    await expect(AdminPage()).rejects.toThrow();
    expectNoQueryRan();
  });

  it('[machine] rejects an otherwise-allowlisted email when ADMIN_EMAILS is UNSET (fails closed, R1)', async () => {
    vi.stubEnv('ADMIN_EMAILS', undefined);
    seedQueries();
    mockAuth.mockResolvedValue({ user: { id: 'u1', email: 'admin@example.com' } });

    await expect(AdminPage()).rejects.toThrow();
    expectNoQueryRan();
  });

  it('[machine] rejects via notFound() — a 404, not a rendered "forbidden" page', async () => {
    seedQueries();
    mockAuth.mockResolvedValue({ user: { id: 'u2', email: 'nobody@example.com' } });

    // Next's notFound() signals 404 by throwing a control-flow error whose
    // digest identifies it. Assert on the digest so a plain crash (which would
    // render a 500 error page, not a 404) cannot pass this test.
    const err = await AdminPage().then(
      () => null,
      (e: unknown) => e as { digest?: string },
    );
    expect(err).not.toBeNull();
    expect(String(err?.digest ?? '')).toContain('NEXT_HTTP_ERROR_FALLBACK;404');
  });
});
