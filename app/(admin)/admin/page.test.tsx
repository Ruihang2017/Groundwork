import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// PLT-03 — the PAGE-LEVEL half of the admin gate (ticket acceptance item 4,
// second layer). middleware.test.ts covers the Edge layer; this file proves the
// server component refuses on its own, because middleware is a single point of
// failure (a matcher edit, a future /api/admin/** route the matcher excludes, or
// a framework-level bypass class).
//
// No DB in the loop: @/lib/db/queries/admin is swapped for four spies, which is
// also how "the guard runs BEFORE any query" is proven — a rejected request must
// leave all four uncalled.
//
// The mock fns come from vi.hoisted so they keep STABLE references across the
// vi.resetModules() each test does (the stable-reference pattern at
// app/api/account/delete/route.test.ts:19-25).
const { mockAuth, mockGetWeeklyCost, mockGetLatency, mockGetDropped, mockGetFunnel } =
  vi.hoisted(() => ({
    mockAuth: vi.fn(),
    mockGetWeeklyCost: vi.fn(),
    mockGetLatency: vi.fn(),
    mockGetDropped: vi.fn(),
    mockGetFunnel: vi.fn(),
  }));

vi.mock('@/auth', () => ({ auth: mockAuth }));

// next/navigation's real notFound() THROWS — mock it as throwing too. A
// non-throwing stub would let execution fall through into the queries and the
// test would prove nothing at all.
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

const LATENCY = {
  parse: { p50: 0, p95: 0 },
  read: { p50: 10, p95: 20 },
  cross: { p50: 0, p95: 0 },
  tailor: { p50: 0, p95: 0 },
  research: { p50: 0, p95: 0 },
  rehearse: { p50: 0, p95: 0 },
};
const FUNNEL = { signupToLibrary: 0.25, fitToTailor: 0.5, interviewingToBrief: 1 };

async function loadPage() {
  vi.resetModules();
  vi.doMock('@/lib/db/queries/admin', () => ({
    getWeeklyCost: mockGetWeeklyCost,
    getLatencyPercentiles: mockGetLatency,
    getDroppedRate: mockGetDropped,
    getFunnelConversion: mockGetFunnel,
  }));
  const mod = await import('@/app/(admin)/admin/page');
  return mod.default;
}

const ORIGINAL_ADMIN_EMAILS = process.env.ADMIN_EMAILS;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetWeeklyCost.mockResolvedValue(1.2345);
  mockGetLatency.mockResolvedValue(LATENCY);
  mockGetDropped.mockResolvedValue(0.75);
  mockGetFunnel.mockResolvedValue(FUNNEL);
  process.env.ADMIN_EMAILS = 'admin@example.com';
});

afterEach(() => {
  if (ORIGINAL_ADMIN_EMAILS === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = ORIGINAL_ADMIN_EMAILS;
  vi.doUnmock('@/lib/db/queries/admin');
  vi.resetModules();
});

function expectNoQueriesRan() {
  expect(mockGetWeeklyCost).not.toHaveBeenCalled();
  expect(mockGetLatency).not.toHaveBeenCalled();
  expect(mockGetDropped).not.toHaveBeenCalled();
  expect(mockGetFunnel).not.toHaveBeenCalled();
}

describe('AdminPage — the page-level admin gate', () => {
  it('notFound()s for a signed-in session whose email is NOT allowlisted, before running any query', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', email: 'nobody@example.com' } });
    const AdminPage = await loadPage();

    await expect(AdminPage()).rejects.toThrow(/NEXT_NOT_FOUND/);
    expectNoQueriesRan();
  });

  it('notFound()s when there is no session at all', async () => {
    mockAuth.mockResolvedValue(null);
    const AdminPage = await loadPage();

    await expect(AdminPage()).rejects.toThrow(/NEXT_NOT_FOUND/);
    expectNoQueriesRan();
  });

  it('notFound()s for a session with no email', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1' } });
    const AdminPage = await loadPage();

    await expect(AdminPage()).rejects.toThrow(/NEXT_NOT_FOUND/);
    expectNoQueriesRan();
  });

  it('notFound()s for an allowlisted-looking email when ADMIN_EMAILS is unset (fail-closed)', async () => {
    delete process.env.ADMIN_EMAILS;
    mockAuth.mockResolvedValue({ user: { id: 'u1', email: 'admin@example.com' } });
    const AdminPage = await loadPage();

    await expect(AdminPage()).rejects.toThrow(/NEXT_NOT_FOUND/);
    expectNoQueriesRan();
  });

  it('renders for an allowlisted email and runs all four aggregations', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', email: 'ADMIN@Example.com' } });
    const AdminPage = await loadPage();

    const element = (await AdminPage()) as {
      props: Record<string, unknown>;
    };

    expect(mockGetWeeklyCost).toHaveBeenCalledTimes(1);
    expect(mockGetLatency).toHaveBeenCalledTimes(1);
    expect(mockGetDropped).toHaveBeenCalledTimes(1);
    expect(mockGetFunnel).toHaveBeenCalledTimes(1);

    // Each query result is handed to the presentational component untransformed;
    // formatting is that component's job (and its own test's).
    expect(element.props.weeklyCostUsd).toBe(1.2345);
    expect(element.props.latency).toEqual(LATENCY);
    expect(element.props.droppedPerOp).toBe(0.75);
    expect(element.props.funnel).toEqual(FUNNEL);
    expect(typeof element.props.generatedAt).toBe('number');
  });

  it('calls the aggregations with NO arguments — no userId can be threaded through the page', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', email: 'admin@example.com' } });
    const AdminPage = await loadPage();
    await AdminPage();

    for (const spy of [mockGetWeeklyCost, mockGetLatency, mockGetDropped, mockGetFunnel]) {
      expect(spy.mock.calls[0]).toEqual([]);
    }
  });
});

describe('AdminPage — route segment config', () => {
  it("declares dynamic = 'force-dynamic' so `next build` never prerenders (and never queries) it", async () => {
    const mod = await import('@/app/(admin)/admin/page');
    expect(mod.dynamic).toBe('force-dynamic');
  });

  it('sets a title', async () => {
    const mod = await import('@/app/(admin)/admin/page');
    expect(mod.metadata.title).toMatch(/admin/i);
  });
});
