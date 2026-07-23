import CompositeScoreBanner from '@/app/(app)/jobs/[id]/_components/composite-score-banner';
import DroppedCountHeader from '@/app/(app)/jobs/[id]/_components/dropped-count-header';
import {
  SUB_SCORE_KEYS,
  SUB_SCORE_LABELS,
  type DroppedView,
} from '@/app/(app)/jobs/[id]/_components/fit-view-model';
import HardRequirementsList from '@/app/(app)/jobs/[id]/_components/hard-requirements-list';
import LowScoreGapCallout from '@/app/(app)/jobs/[id]/_components/low-score-gap-callout';
import SubScoreCard from '@/app/(app)/jobs/[id]/_components/sub-score-card';
import type { FitReport, JdExtract, Ledger } from '@/lib/schemas/pipeline';

// FIT-03 — the Fit Report's SINGLE composition point.
//
// WHY THIS FILE EXISTS AT ALL: the report is rendered on TWO paths — the server page
// (`app/(app)/jobs/[id]/page.tsx`, when `job.fit` is already persisted) and the client
// auto-runner (`fit-auto-runner.tsx`, rendering straight from FIT-02's response body,
// plan D4). Without one composition point each path would assemble the five
// components itself and could silently drift in ORDER or CONTENT — and that drift
// would be invisible to every component-level test, because each component would keep
// passing on its own. Both page tests exercise this file; it has no test of its own.
//
// THE ORDER IS FIXED BY PRD, not by taste:
//   1. DroppedCountHeader   §5.7 產出展示: "dropped > 0 表头计数" — a HEADER count.
//   2. HardRequirementsList §5.2: "硬性条件…置顶展示" — literally "displayed at top".
//   3. CompositeScoreBanner §5.2: "综合分 + 档位…档位给建议语" + the mandatory 诚实标注.
//   4. LowScoreGapCallout   §5.2: "低分页面同时展示'如果仍要投，优先补哪两个 gap'".
//   5. The four SubScoreCards §5.2: "四个子分…各自列出支撑 bindings 与 gaps".
// Reordering 1–5 is a PRD-visible change, not a layout tweak.
//
// NOT a client component, and none of its five children is either (plan E13): marking
// this `'use client'` would defeat the entire point of the server-rendered path.

export default function FitReportView({
  jd,
  ledger,
  fit,
  dropped,
}: {
  jd: JdExtract;
  ledger: Ledger;
  fit: FitReport;
  dropped: DroppedView;
}) {
  return (
    <section>
      <DroppedCountHeader
        droppedCount={dropped.count}
        items={dropped.items}
        partial={dropped.partial}
      />
      <HardRequirementsList items={fit.hardRequirements} />
      <CompositeScoreBanner fit={fit} />
      <LowScoreGapCallout fit={fit} jd={jd} />

      <h2 style={{ fontSize: '1.1rem', margin: '0 0 0.5rem' }}>Sub-scores</h2>
      {SUB_SCORE_KEYS.map((key) => (
        <SubScoreCard
          key={key}
          label={SUB_SCORE_LABELS[key]}
          sub={fit.subScores[key]}
          jd={jd}
          ledger={ledger}
        />
      ))}
    </section>
  );
}
