import { notFound } from 'next/navigation';
import type { CSSProperties } from 'react';

import { isAdminEmail } from '@/app/(admin)/_lib/admin-access';
import { auth } from '@/auth';
import {
  getDroppedRate,
  getFunnelConversion,
  getLatencyPercentiles,
  getWeeklyCost,
} from '@/lib/db/queries/admin';
import { UsageOp } from '@/lib/schemas/persisted';

// PLT-03 Deliverable 2 — the /admin observability page (PRD §8.4: "一张表加一页
// 汇总就是这个量级 observability 的全部"). Note the path: app/(admin)/admin/page.tsx
// serves /admin. It must NOT be app/(admin)/page.tsx, which resolves to "/" and
// collides with app/page.tsx (Next.js E28, "two parallel pages resolve to the
// same path" — the exact failure FND-09 hit).
//
// No APM, no third-party analytics SDK, no polling/auto-refresh: a full page
// reload IS the refresh model (PRD §8.4 "不上 APM"; §8.3 "v1 不接第三方分析").

// Required, not decorative: this keeps `next build` from prerendering a page
// whose render path reaches auth() -> buildAuthConfig() -> @/db/index and the
// DATABASE_URL fail-fast. app/layout.tsx already forces dynamic for the whole
// tree; this is the same belt-and-suspenders that file documents for itself.
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Admin — Groundwork' };

const cell: CSSProperties = {
  borderBottom: '1px solid #eee',
  padding: '0.35rem 0.75rem 0.35rem 0',
  textAlign: 'left',
};
const num: CSSProperties = { ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const note: CSSProperties = { color: '#666', fontSize: '0.85rem', margin: '0.35rem 0 0' };
const section: CSSProperties = { marginTop: '2rem' };

// Locale-INDEPENDENT formatting throughout (toFixed, never a bare
// Intl.NumberFormat() with no explicit locale) so the rendered string cannot
// depend on the server's locale.
function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export default async function AdminPage() {
  // The gate runs BEFORE any query — a security requirement, not stylistic
  // ordering, and app/(admin)/admin/page.test.tsx asserts it by proving no query
  // mock was called on a rejected request. Defense in depth: middleware.ts is the
  // first line, but it is a SEPARATE runtime with its own env semantics, so a
  // server component computing cross-user aggregates must not rely on it alone.
  //
  // notFound() rather than a redirect or a rendered "forbidden" page: it returns
  // 404 and renders nothing, so an authenticated non-admin who somehow reaches
  // the RSC gets no aggregate byte. (Middleware's 403 already answers "does this
  // path exist"; this gate's job is to leak no DATA.)
  const session = await auth();
  if (!isAdminEmail(session?.user?.email)) notFound();

  // No try/catch around these: if a query throws, let the error boundary show a
  // failure. A silently-zeroed cost dashboard is worse than a broken one.
  const [weeklyCostUsd, latency, droppedPerOp, funnel] = await Promise.all([
    getWeeklyCost(),
    getLatencyPercentiles(),
    getDroppedRate(),
    getFunnelConversion(),
  ]);

  return (
    <section style={{ maxWidth: '44rem' }}>
      <h1>Admin observability</h1>

      <div style={section}>
        <h2>Weekly cost (last 7 days)</h2>
        {/* Four decimals deliberately: PRD §9's per-operation costs are ~$0.01–$0.30,
            so toFixed(2) would render a real early week as "$0.00". */}
        <p style={{ fontSize: '1.5rem', margin: 0 }}>${weeklyCostUsd.toFixed(4)}</p>
      </div>

      <div style={section}>
        <h2>Latency by pipeline stage (last 7 days)</h2>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={cell}>op</th>
              <th style={num}>p50 (ms)</th>
              <th style={num}>p95 (ms)</th>
              <th style={num}>samples</th>
            </tr>
          </thead>
          <tbody>
            {UsageOp.options.map((op) => {
              const row = latency[op];
              // No samples in the window ⇒ an em dash, never "0" — "this stage
              // completed in 0 ms" would be an affirmatively false claim
              // (PRD §5.5 "宁可暴露不完整，不静默吞掉").
              const empty = row.samples === 0;
              return (
                <tr key={op}>
                  <td style={cell}>{op}</td>
                  <td style={num}>{empty ? '—' : row.p50}</td>
                  <td style={num}>{empty ? '—' : row.p95}</td>
                  <td style={num}>{row.samples}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p style={note}>
          These are pipeline stages (usage_events.op), not the Fit / Tailor / Prep latency
          budgets of PRD §7 — one user-facing Fit is two stages (read + cross), so an op&apos;s
          p50 is not comparable to a §7 budget. Percentiles are nearest-rank
          (percentile_disc): each figure is an actually observed request duration.
        </p>
      </div>

      <div style={section}>
        <h2>Dropped items per operation (last 7 days)</h2>
        <p style={{ fontSize: '1.5rem', margin: 0 }}>{droppedPerOp.toFixed(2)}</p>
        <p style={note}>
          Average dropped items per usage event — not a percentage, and not the Q1 eval
          gate&apos;s dropped rate (PRD §6, &lt; 15%), which divides by items considered.
          usage_events has no &quot;items considered&quot; column, so the two numbers are not
          comparable.
        </p>
      </div>

      <div style={section}>
        <h2>Funnel conversion (all time)</h2>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={cell}>step</th>
              <th style={num}>value</th>
              <th style={num}>PRD §7 target</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={cell}>signup → library</td>
              <td style={num}>{pct(funnel.signupToLibrary)}</td>
              <td style={num}>≥ 50%</td>
            </tr>
            <tr>
              <td style={cell}>fit → tailor</td>
              <td style={num}>{pct(funnel.fitToTailor)}</td>
              <td style={num}>≥ 25%</td>
            </tr>
            <tr>
              <td style={cell}>interviewing → brief</td>
              <td style={num}>{pct(funnel.interviewingToBrief)}</td>
              <td style={num}>≥ 60%</td>
            </tr>
          </tbody>
        </table>
        <p style={note}>
          All time, not the 7-day window used above. PRD §7 recalibrates these targets after
          two weeks of real data, and a ratio over a handful of users is noise — read the
          direction, not the number.
        </p>
      </div>
    </section>
  );
}
