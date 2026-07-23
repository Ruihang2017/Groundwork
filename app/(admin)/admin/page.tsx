import { notFound } from 'next/navigation';

import ObservabilityDashboard from '@/app/(admin)/admin/_components/observability-dashboard';
import { isAdminEmail } from '@/app/(admin)/_lib/admin-emails';
import { auth } from '@/auth';
import {
  getDroppedRate,
  getFunnelConversion,
  getLatencyPercentiles,
  getWeeklyCost,
} from '@/lib/db/queries/admin';

// PLT-03 Deliverable 2 — the /admin observability page (PRD §8.4). Note the path:
// app/(admin)/admin/page.tsx serves /admin. It must NOT be app/(admin)/page.tsx,
// which resolves to "/" and collides with app/page.tsx (Next.js E28, "two
// parallel pages resolve to the same path" — the exact failure FND-09 hit).
//
// This file is the ONLY permitted importer of @/lib/db/queries/admin (that
// module's header rule 1; lib/db/queries/admin.test.ts enforces it mechanically).

// Required, not decorative: without it Next may try to prerender this page at
// build time, which would execute the DB queries during `next build` — a failure
// on a checkout with no DATABASE_URL, and stale baked-in numbers on a real
// deployment. app/layout.tsx:11 already declares it for the whole tree; declaring
// it here removes any reliance on segment-config cascade semantics (the same
// belt-and-suspenders that file records for itself).
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Admin — observability' };

export default async function AdminPage() {
  // THE GATE RUNS BEFORE ANY QUERY — a security requirement, not stylistic
  // ordering; page.test.tsx proves it by asserting no query mock was called on a
  // rejected request. Defense in depth on top of middleware.ts's 403: middleware
  // is a single point of failure (a matcher edit, a future /api/admin/** route
  // which the matcher excludes entirely, or a framework-level bypass of the
  // historic CVE-2025-29927 class), and this costs one line. next@15.5.20 is well
  // past that CVE's 15.2.3 fix — this is depth, not a patch.
  //
  // notFound() rather than a redirect or a rendered "forbidden" page: it is the
  // idiomatic RSC refusal, returns 404 and renders nothing, so an authenticated
  // non-admin who somehow reaches this RSC gets no aggregate byte. The status
  // asymmetry with middleware's 403 is intentional — in normal operation this
  // branch is unreachable, and a 404 from an unreachable guard leaks less.
  const session = await auth();
  if (!isAdminEmail(session?.user?.email)) notFound();

  // All four in one Promise.all — this is exactly the same-tick concurrency the
  // memoized dbIndex() in @/lib/db/queries/admin exists for. No try/catch: if a
  // query throws, let Next's error boundary show a failure. A silently-zeroed
  // cost dashboard is worse than a visibly broken one.
  //
  // The four calls are separate statements, so an event landing between them can
  // make the numbers mutually inconsistent by one event. Accepted for an internal
  // summary page (PRD §8.4 asks for "一张表加一页汇总", not a consistent analytics
  // snapshot). Do NOT "fix" it by wrapping them in a transaction: the production
  // client is neon-http, whose .transaction() throws unconditionally, so that
  // change would pass every PGlite-backed test and fail in production.
  const [weeklyCostUsd, latency, droppedPerOp, funnel] = await Promise.all([
    getWeeklyCost(),
    getLatencyPercentiles(),
    getDroppedRate(),
    getFunnelConversion(),
  ]);

  return (
    <ObservabilityDashboard
      weeklyCostUsd={weeklyCostUsd}
      latency={latency}
      droppedPerOp={droppedPerOp}
      funnel={funnel}
      generatedAt={Date.now()}
    />
  );
}
