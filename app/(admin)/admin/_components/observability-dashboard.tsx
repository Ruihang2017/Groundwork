import type { CSSProperties } from 'react';

import type { FunnelConversion, OpLatency } from '@/lib/db/queries/admin';
import { UsageOp } from '@/lib/schemas/persisted';

// PLT-03 Deliverable 2, presentation half. A SYNCHRONOUS, props-only server
// component: no 'use client', no data fetching, no auth() — app/(admin)/admin/
// page.tsx owns the gate and the queries, this file owns the rendering.
//
// Splitting the two is not decoration: it makes the whole rendering surface
// testable with this repo's existing sync-component pattern
// (app/(legal)/privacy/page.test.tsx, app/(app)/settings/page.test.tsx) instead
// of depending on `render(await Page())` for an async RSC, which
// @testing-library/react supports only incidentally.
//
// PRD names no visual design for this internal tool ("一张表加一页汇总就是这个
// 量级 observability 的全部"), so: plain semantic HTML with inline styles,
// matching app/(app)/settings/page.tsx's existing style. No polling, no
// auto-refresh, no chart library — a full page reload IS the refresh model.
//
// NO USER-IDENTIFYING CONTENT MAY EVER BE RENDERED HERE — no email, no user id,
// no company or role name. That is both a ticket Non-goal and a privacy boundary
// (PLT-01's published privacy page promises account-scoped data handling);
// observability-dashboard.test.tsx asserts the rendered text matches no
// email-shaped and no UUID-shaped string.

export type ObservabilityDashboardProps = {
  /** Total USD across all users over the rolling 7-day window. */
  weeklyCostUsd: number;
  /** p50/p95 durationMs per pipeline stage; `{0, 0}` means "no events". */
  latency: Record<UsageOp, OpLatency>;
  /** SUM(droppedCount) / COUNT(*) — items per operation, NOT a percentage. */
  droppedPerOp: number;
  /** All-time ratios in [0, 1]. */
  funnel: FunnelConversion;
  /** Epoch-ms the numbers were read at; the 7-day window ends here. */
  generatedAt: number;
};

const cell: CSSProperties = {
  borderBottom: '1px solid #eee',
  padding: '0.35rem 0.75rem 0.35rem 0',
  textAlign: 'left',
};
const num: CSSProperties = {
  ...cell,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
};
const note: CSSProperties = { color: '#666', fontSize: '0.85rem', margin: '0.35rem 0 0' };
const section: CSSProperties = { marginTop: '2rem' };
const big: CSSProperties = { fontSize: '1.5rem', margin: 0 };

// Locale-INDEPENDENT formatting everywhere (toFixed / toISOString, never a bare
// Intl.* with no explicit locale) so a rendered string cannot depend on the
// server's locale — which would also make these tests machine-dependent.
function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * percentile_cont interpolates, so a percentile can land on float noise
 * (954.9999999999999). Rounding to whole milliseconds here — at the DISPLAY
 * boundary, not in the query — keeps the stored/returned value honest while the
 * page stays readable. Sub-millisecond precision is meaningless for latencies
 * PRD §7 budgets in tens of seconds.
 */
function ms(value: number): string {
  return String(Math.round(value));
}

export default function ObservabilityDashboard({
  weeklyCostUsd,
  latency,
  droppedPerOp,
  funnel,
  generatedAt,
}: ObservabilityDashboardProps) {
  const windowEnd = new Date(generatedAt).toISOString();

  return (
    <section style={{ maxWidth: '46rem' }}>
      <h1>Admin observability</h1>
      <p style={note}>
        Cost, latency and dropped figures cover a <strong>rolling 7 days</strong> ending{' '}
        {windowEnd}. Funnel conversion is <strong>all time</strong> — the two blocks do not
        cover the same period. Every number below is aggregated across all users; no
        per-user data is shown or queried.
      </p>

      <div style={section}>
        <h2>Weekly cost (rolling 7 days)</h2>
        {/* Four decimals deliberately, against plan §2.5's "2 decimals": PRD §9's
            per-operation costs are ~$0.01–$0.30, so an early real week would
            render as "$0.00" at 2dp on the one page whose job is cost tracking.
            Recorded as a deviation in the ticket Changelog. */}
        <p style={big}>${weeklyCostUsd.toFixed(4)}</p>
      </div>

      <div style={section}>
        <h2>Latency by pipeline stage (rolling 7 days)</h2>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={cell}>op</th>
              <th style={num}>p50 (ms)</th>
              <th style={num}>p95 (ms)</th>
            </tr>
          </thead>
          <tbody>
            {UsageOp.options.map((op) => {
              const row = latency[op];
              // `{p50: 0, p95: 0}` is the query layer's "no events for this op in
              // the window" convention. Render an em dash, never "0" — "this
              // stage completed in 0 ms" would be an affirmatively false claim
              // (PRD §5.5 "宁可暴露不完整，不静默吞掉").
              const empty = row.p50 === 0 && row.p95 === 0;
              return (
                <tr key={op}>
                  <td style={cell}>{op}</td>
                  <td style={num}>{empty ? '—' : ms(row.p50)}</td>
                  <td style={num}>{empty ? '—' : ms(row.p95)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p style={note}>
          These are pipeline stages (usage_events.op), not the Fit / Tailor / Prep latency
          budgets of PRD §7 — one user-facing Fit is two stages (read + cross), so an
          op&apos;s p50 is not comparable to a §7 budget. An em dash means no events for
          that stage in the window.
        </p>
      </div>

      <div style={section}>
        <h2>Dropped items per operation (7d avg)</h2>
        <p style={big}>{droppedPerOp.toFixed(2)}</p>
        <p style={note}>
          Average dropped items per usage event — <strong>not a percentage</strong>, and not
          the Q1 eval gate&apos;s dropped rate (PRD §6, &lt; 15%), which divides by items
          considered. usage_events has no &quot;items considered&quot; column, so the two
          numbers are not comparable and this one must not be read against that gate.
        </p>
      </div>

      <div style={section}>
        <h2>Funnel conversion (all time)</h2>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={cell}>step</th>
              <th style={cell}>definition</th>
              <th style={num}>value</th>
              <th style={num}>PRD §7 target</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={cell}>signup → library</td>
              <td style={cell}>
                users with a non-empty, not-deleted library ÷ registered users (a deleted
                account leaves both sides)
              </td>
              <td style={num}>{pct(funnel.signupToLibrary)}</td>
              <td style={num}>≥ 50%</td>
            </tr>
            <tr>
              <td style={cell}>fit → tailor</td>
              <td style={cell}>
                jobs with a tailored resume ÷ all jobs (every job has a fit report by
                construction)
              </td>
              <td style={num}>{pct(funnel.fitToTailor)}</td>
              <td style={num}>≥ 25%</td>
            </tr>
            <tr>
              <td style={cell}>interviewing → brief</td>
              <td style={cell}>
                jobs currently in status &quot;interviewing&quot; that have a brief ÷ jobs
                currently in status &quot;interviewing&quot; (current state, not history)
              </td>
              <td style={num}>{pct(funnel.interviewingToBrief)}</td>
              <td style={num}>≥ 60%</td>
            </tr>
          </tbody>
        </table>
        <p style={note}>
          All time, not the 7-day window used above. A ratio with a zero denominator reads
          0% — on an empty database that means &quot;no data yet&quot;, not failure. PRD §7
          recalibrates these targets after two weeks of real data, and a ratio over a
          handful of users is noise: read the direction, not the number.
        </p>
      </div>
    </section>
  );
}
