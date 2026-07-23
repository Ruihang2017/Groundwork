'use client';

import Link from 'next/link';
import { useState } from 'react';

import AlignmentTable from '@/app/(app)/jobs/[id]/resume/_components/alignment-table';
import DraftEditor from '@/app/(app)/jobs/[id]/resume/_components/draft-editor';
import DroppedCountHeader from '@/app/(app)/jobs/[id]/resume/_components/dropped-count-header';
import EditCard from '@/app/(app)/jobs/[id]/resume/_components/edit-card';
import MarkAppliedButton from '@/app/(app)/jobs/[id]/resume/_components/mark-applied-button';
import PrintView from '@/app/(app)/jobs/[id]/resume/_components/print-view';
import { deriveDraft } from '@/app/(app)/jobs/[id]/resume/_lib/draft-derivation';
import type { DroppedItem } from '@/app/(app)/jobs/[id]/resume/_lib/dropped-view';
import type { TailoredResume } from '@/lib/schemas/persisted';

// TLR-02 (plan §3.10) — the single stateful hub composing Deliverables 1–5, the editor,
// and both export surfaces. Rendered on BOTH the reload path (by page.tsx) and the
// fresh-generate path (by tailor-generator.tsx).
//
// STATE: `accepted` (a Set of edit indices, initially EMPTY — every edit opt-in false per
// PRD's "用户逐条采纳") and `draft` (initially `deriveDraft(fullDraftMd, edits, ∅)`, i.e.
// `fullDraftMd`).
//
// D6 — TOGGLING AN EDIT RE-DERIVES AND OVERWRITES THE DRAFT. Deliverable 3 says the derived
// content is "recomputed whenever the user toggles an edit's accept state" AND the draft is
// "further freely editable afterward"; those conflict once the user has hand-edited, so v1
// takes the literal spec (toggle → re-derive → overwrite) with a visible warning note. The
// alternative (freeze derivation after the first manual edit) is plan Q2.
//
// EXPORT (D1) — the hub renders a screen-HIDDEN PrintView providing the single `#print-root`
// that "Print / Save as PDF" (`window.print()`) targets. Because that render lives in the
// same client tree as the editor, printing captures the CURRENT working draft with no server
// round-trip and no storage (Deliverable 6 resolution). Exactly ONE `#print-root` per page.
//
// PRIVACY (plan R8, PRD §8.1): NO `console.*`; NO localStorage/sessionStorage/cookie/URL
// persistence of any draft/alignment/edit content. The résumé is the user's most sensitive
// data. Relative same-origin fetches only (in MarkAppliedButton).

/** D6's warning, exported so the hub and its test share one string. */
export const REDERIVE_NOTE =
  'Choosing edits rebuilds the draft below and discards manual changes — finish choosing edits before hand-editing.';

export default function ResumeWorkspace({
  jobId,
  tailored,
  projectNames,
  droppedItems,
  droppedCount,
}: {
  jobId: string;
  tailored: TailoredResume;
  projectNames: Record<string, string>;
  droppedItems: DroppedItem[];
  droppedCount: number;
}) {
  const [accepted, setAccepted] = useState<Set<number>>(() => new Set());
  const [draft, setDraft] = useState<string>(() =>
    deriveDraft(tailored.fullDraftMd, tailored.edits, new Set()),
  );

  function onToggle(index: number, isAccepted: boolean) {
    // Compute the next set from the current one (event-time state is current), so the
    // re-derive below does not depend on a side effect inside a state updater.
    const next = new Set(accepted);
    if (isAccepted) next.add(index);
    else next.delete(index);
    setAccepted(next);
    // D6: re-derive from the ORIGINAL fullDraftMd + the new accepted set — overwrites any
    // manual edits (the note warns the user).
    setDraft(deriveDraft(tailored.fullDraftMd, tailored.edits, next));
  }

  return (
    <section>
      <DroppedCountHeader droppedCount={droppedCount} items={droppedItems} />

      <AlignmentTable alignment={tailored.alignment} />

      <section style={{ margin: '0 0 2rem' }}>
        <h2 style={{ fontSize: '1.1rem', margin: '0 0 0.5rem' }}>Suggested edits</h2>
        <p style={{ color: '#555', margin: '0 0 1rem' }}>{REDERIVE_NOTE}</p>
        {tailored.edits.length === 0 ? (
          <p>No edits were suggested for this draft.</p>
        ) : (
          tailored.edits.map((edit, index) => (
            <EditCard
              key={`${index}-${edit.projectId}`}
              edit={edit}
              index={index}
              accepted={accepted.has(index)}
              projectName={projectNames[edit.projectId] ?? edit.projectId}
              onToggle={onToggle}
            />
          ))
        )}
      </section>

      <DraftEditor value={draft} onChange={setDraft} />

      <p>
        <button type="button" onClick={() => window.print()}>
          Print / Save as PDF
        </button>
      </p>
      <p>
        <Link href={`/jobs/${jobId}/resume/print`}>
          Open a clean print view of the generated draft
        </Link>
      </p>

      <MarkAppliedButton jobId={jobId} />

      {/* Screen-hidden; provides the single #print-root for window.print() with the
          CURRENT draft (D1). */}
      <PrintView draft={draft} screenHideRoot />
    </section>
  );
}
