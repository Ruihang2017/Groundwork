// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import ObservabilityDashboard, {
  type ObservabilityDashboardProps,
} from '@/app/(admin)/admin/_components/observability-dashboard';
import { UsageOp } from '@/lib/schemas/persisted';

// @testing-library/react's auto-cleanup only self-registers under vitest
// `globals: true`, which this repo does NOT enable — clean up explicitly (same
// pattern as app/(legal)/privacy/page.test.tsx).
afterEach(cleanup);

const GENERATED_AT = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z

function props(overrides: Partial<ObservabilityDashboardProps> = {}): ObservabilityDashboardProps {
  return {
    weeklyCostUsd: 1.2345,
    latency: {
      parse: { p50: 120, p95: 300 },
      read: { p50: 25, p95: 38.5 },
      cross: { p50: 0, p95: 0 },
      tailor: { p50: 0, p95: 0 },
      research: { p50: 0, p95: 0 },
      rehearse: { p50: 954.9999999999999, p95: 1000 },
    },
    droppedPerOp: 0.75,
    funnel: { signupToLibrary: 0.25, fitToTailor: 0.5, interviewingToBrief: 0.6 },
    generatedAt: GENERATED_AT,
    ...overrides,
  };
}

describe('ObservabilityDashboard — the four PRD §8.4 views', () => {
  it('renders a heading', () => {
    render(<ObservabilityDashboard {...props()} />);
    expect(
      screen.getByRole('heading', { name: /admin observability/i, level: 1 }),
    ).toBeTruthy();
  });

  it('states BOTH window labels — 7-day for cost/latency/dropped, all time for the funnel', () => {
    const { container } = render(<ObservabilityDashboard {...props()} />);
    expect(container.textContent).toMatch(/rolling 7 days/i);
    expect(container.textContent).toMatch(/all time/i);
    // The window end is rendered as an ISO string: locale-independent, so this
    // assertion cannot depend on the machine's timezone.
    expect(container.textContent).toContain(new Date(GENERATED_AT).toISOString());
  });

  it('shows the weekly cost with enough precision for PRD §9-scale figures', () => {
    const { container } = render(
      <ObservabilityDashboard {...props({ weeklyCostUsd: 0.0043 })} />,
    );
    // 2 decimals would render this real early-week total as "$0.00" on the one
    // page whose job is cost tracking.
    expect(container.textContent).toContain('$0.0043');
  });

  it('renders one latency row per UsageOp, in enum order', () => {
    render(<ObservabilityDashboard {...props()} />);
    // The latency table is the first one; read its body rows' leading cell.
    const latencyTable = screen.getAllByRole('table')[0];
    const opColumn = within(latencyTable)
      .getAllByRole('row')
      .slice(1) // drop the header row
      .map((row) => within(row).getAllByRole('cell')[0].textContent);

    expect(opColumn).toEqual([...UsageOp.options]);
  });

  it('renders an em dash — never "0" — for an op with no events in the window', () => {
    render(<ObservabilityDashboard {...props()} />);
    const crossRow = screen.getByText('cross').closest('tr');
    expect(crossRow).toBeTruthy();
    const cells = within(crossRow as HTMLElement)
      .getAllByRole('cell')
      .map((cell) => cell.textContent);
    expect(cells).toEqual(['cross', '—', '—']);
  });

  it('rounds interpolated percentiles to whole milliseconds (percentile_cont float noise)', () => {
    render(<ObservabilityDashboard {...props()} />);
    const row = screen.getByText('rehearse').closest('tr') as HTMLElement;
    const cells = within(row).getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells).toEqual(['rehearse', '955', '1000']);
    expect(document.body.textContent).not.toContain('954.9999999999999');
  });

  it('labels the dropped figure as items PER OPERATION and explicitly not the Q1 15% rate', () => {
    const { container } = render(<ObservabilityDashboard {...props()} />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/dropped items per operation/i);
    expect(text).toMatch(/not a percentage/i);
    expect(text).toMatch(/15%/); // names the gate it must NOT be compared against
    expect(text).toContain('0.75');
    // The heading that names the figure must NOT call it a rate, and the value
    // must never be rendered as a percentage. (The explanatory note below it does
    // mention "dropped rate" — precisely to say this number is not that one.)
    const heading = screen.getByRole('heading', { name: /dropped/i, level: 2 });
    expect(heading.textContent).toMatch(/per operation/i);
    expect(heading.textContent).not.toMatch(/rate/i);
    expect(text).not.toContain('75.0%');
    expect(text).not.toContain('75%');
  });

  it('renders the three funnel ratios as percentages next to their PRD §7 targets', () => {
    const { container } = render(<ObservabilityDashboard {...props()} />);
    const text = container.textContent ?? '';
    expect(text).toContain('25.0%');
    expect(text).toContain('50.0%');
    expect(text).toContain('60.0%');
    expect(text).toContain('≥ 50%');
    expect(text).toContain('≥ 25%');
    expect(text).toContain('≥ 60%');
  });

  it('labels each funnel ratio with its exact definition', () => {
    const { container } = render(<ObservabilityDashboard {...props()} />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/non-empty, not-deleted library ÷ registered users/i);
    expect(text).toMatch(/jobs with a tailored resume ÷ all jobs/i);
    expect(text).toMatch(/current state, not history/i);
  });

  it('renders zeroes as 0%/$0.0000 without NaN when the database is empty', () => {
    const { container } = render(
      <ObservabilityDashboard
        {...props({
          weeklyCostUsd: 0,
          droppedPerOp: 0,
          funnel: { signupToLibrary: 0, fitToTailor: 0, interviewingToBrief: 0 },
          latency: {
            parse: { p50: 0, p95: 0 },
            read: { p50: 0, p95: 0 },
            cross: { p50: 0, p95: 0 },
            tailor: { p50: 0, p95: 0 },
            research: { p50: 0, p95: 0 },
            rehearse: { p50: 0, p95: 0 },
          },
        })}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/NaN/);
    expect(text).toContain('$0.0000');
    expect(text).toContain('0.0%');
    expect(text).toMatch(/no data yet/i);
  });
});

describe('ObservabilityDashboard — privacy boundary', () => {
  it('renders NO user-identifying content: no email-shaped and no UUID-shaped string', () => {
    const { container } = render(<ObservabilityDashboard {...props()} />);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.\w+/);
    expect(text).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });

  it('takes only aggregate props — there is no prop through which a row could arrive', () => {
    // The component signature is the guarantee: five scalars/records of scalars.
    // If a future edit adds a `users`/`events` prop, this list changes and the
    // reviewer sees it in the diff.
    const keys = Object.keys(props()).sort();
    expect(keys).toEqual([
      'droppedPerOp',
      'funnel',
      'generatedAt',
      'latency',
      'weeklyCostUsd',
    ]);
  });
});
