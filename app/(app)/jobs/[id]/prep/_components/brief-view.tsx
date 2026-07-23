import AskThemList from '@/app/(app)/jobs/[id]/prep/_components/ask-them-list';
import DroppedCountHeader, {
  type DroppedItem,
} from '@/app/(app)/jobs/[id]/prep/_components/dropped-count-header';
import IntelCard from '@/app/(app)/jobs/[id]/prep/_components/intel-card';
import PositioningSummary from '@/app/(app)/jobs/[id]/prep/_components/positioning-summary';
import QuestionList from '@/app/(app)/jobs/[id]/prep/_components/question-list';
import ResearchFailBanner from '@/app/(app)/jobs/[id]/prep/_components/research-fail-banner';
import type { Intel, Ledger, RehearseQuestion } from '@/lib/schemas/pipeline';
import { UNCOVERED_MARKER } from '@/lib/validation';

// PRP-04 (plan §2.2 / D8) — the Brief's SINGLE composition point.
//
// WHY THIS FILE EXISTS: the brief is rendered on TWO paths — the server page
// (`prep/page.tsx`, when a `Brief` is already persisted) and the client generator
// (`brief-generator.tsx`, rendering straight from PRP-02's REHEARSE response body, plan D3).
// Without one composition point each path would assemble the seven children itself and could
// silently drift in ORDER or CONTENT — drift invisible to every component-level test, because
// each child keeps passing on its own. Mirrors 04-fit/fit-report-view.tsx verbatim in intent.
//
// NOT a client component, and none of its children is either (plan D8/R5): marking this
// `'use client'` would defeat the server-rendered reload path. It takes only plain data props
// (no hooks, no I/O), so it renders correctly in either the server tree or the client tree.
//
// THE ORDER IS FIXED BY PRD §5.7 (header count) + §5.4 (content order) + the ticket Goal —
// this is PRD-visible, not taste:
//   1. DroppedCountHeader   §5.7 "dropped > 0 表头计数" — a HEADER count (nothing at 0).
//   2. ResearchFailBanner   §5.7 "research fail 标红" (only when intel === null; D9).
//   3. IntelCard            §5.4 "intel" (only when intel !== null; D9).
//   4. Ledger recap         §5.4 "ledger" (D11; nothing when ledger is null/empty).
//   5. QuestionList         §5.4 "预测问题".
//   6. AskThemList          §5.4 "askThem".
//   7. PositioningSummary   §5.4 "positioning".
// The banner (2) and card (3) are BOTH rendered unconditionally and self-guard, so a failed
// RESEARCH shows the banner ALONGSIDE the questions/askThem/positioning, never instead of them
// (Deliverable 1 / acceptance item 3).
//
// D11 — the LEDGER RECAP is a minimal inline section (a strengths count + each gap's
// probe/play), grounded in PRD §1 F3 ("interviews are decided on the gaps"), NOT a re-import
// of the Fit tab's full sub-score breakdown (that is the Fit tab's job). Layer-2 injected gaps
// carry `probe === UNCOVERED_MARKER` + `play: ''` by design (FND-07); they get an honest line
// rather than an empty "Your bridge:" bullet, exactly as low-score-gap-callout.tsx does.

const headingStyle = { fontSize: '1.1rem', margin: '0 0 0.5rem' } as const;

/** The relaxed rehearse shape (questions may be 0..5, plan D4) — consumed as data. */
type RehearseData = {
  questions: RehearseQuestion[];
  askThem: string[];
  positioning: string;
};

export default function BriefView({
  intel,
  rehearse,
  ledger,
  projectNames,
  droppedCount,
  droppedItems,
}: {
  intel: Intel | null;
  rehearse: RehearseData;
  ledger: Ledger | null;
  projectNames: Record<string, string>;
  droppedCount: number;
  droppedItems: DroppedItem[];
}) {
  return (
    <section aria-labelledby="prep-heading">
      <h2 id="prep-heading">Interview brief</h2>

      <DroppedCountHeader droppedCount={droppedCount} items={droppedItems} />
      <ResearchFailBanner intel={intel} />
      <IntelCard intel={intel} />
      <LedgerRecap ledger={ledger} />
      <QuestionList questions={rehearse.questions} projectNames={projectNames} />
      <AskThemList askThem={rehearse.askThem} />
      <PositioningSummary positioning={rehearse.positioning} />
    </section>
  );
}

/** D11 — the compact "where this interview will be decided" recap. Nothing when empty. */
function LedgerRecap({ ledger }: { ledger: Ledger | null }) {
  if (!ledger || (ledger.bindings.length === 0 && ledger.gaps.length === 0)) return null;

  const strengths = ledger.bindings.length;
  const gaps = ledger.gaps.length;

  return (
    <section style={{ margin: '0 0 1.5rem' }} aria-label="Where this interview will be decided">
      <h2 style={headingStyle}>Where this interview will be decided</h2>
      <p style={{ margin: '0 0 0.5rem' }}>
        {strengths === 1 ? '1 strength matched' : `${strengths} strengths matched`} ·{' '}
        {gaps === 1 ? '1 gap to bridge' : `${gaps} gaps to bridge`}
      </p>
      {gaps > 0 ? (
        <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
          {ledger.gaps.map((gap, index) => {
            const injected = gap.probe === UNCOVERED_MARKER;
            return (
              <li key={`${index}-${gap.requirementId}`} style={{ margin: '0 0 0.5rem' }}>
                {injected ? (
                  <p style={{ margin: 0 }}>
                    A requirement here was not assessed — re-run Fit to fill it in.
                  </p>
                ) : (
                  <>
                    <p style={{ margin: '0 0 0.25rem' }}>They may probe: {gap.probe}</p>
                    {gap.play !== '' ? (
                      <p style={{ margin: 0 }}>Your bridge: {gap.play}</p>
                    ) : null}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
