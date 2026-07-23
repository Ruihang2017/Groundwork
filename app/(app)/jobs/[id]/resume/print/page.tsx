import Link from 'next/link';

import PrintView from '@/app/(app)/jobs/[id]/resume/_components/print-view';
import { requireUserId } from '@/lib/auth/session';
import { getTailoredResume } from '@/lib/db/queries/tailored-resumes';

// TLR-02 Deliverable 6 (plan §3.15 / D2) — the standalone print-optimized route. Renders
// the PERSISTED draft (`getTailoredResume(...).fullDraftMd`) through the shared PrintView,
// visible on screen with its own print button and isolating `#print-root` for `@media print`.
//
// This is the "simpler v1 scope of printing the server-persisted draft as-is" the ticket
// names as acceptable — a clean, linkable, chrome-free view of the GENERATED draft.
// DOCUMENTED LIMITATION (plan D2 / Feedback obligation #2): it shows the persisted draft, NOT
// the user's unsaved in-editor edits — that is the in-page hub's `window.print()` path. The
// two surfaces are labelled to avoid confusion; whether to keep both is plan Q1.
//
// If no draft exists yet, render a small message + a link back to the editor — do NOT
// `notFound()` (the JOB exists; only the draft does not). Static, build-guarded import of
// `getTailoredResume`; `requireUserId` propagates.

export const dynamic = 'force-dynamic';

export default async function ResumePrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await requireUserId();

  const tailored = await getTailoredResume(userId, id);

  if (tailored === null) {
    return (
      <section>
        <p>No tailored draft yet — generate one first.</p>
        <p>
          <Link href={`/jobs/${id}/resume`}>Back to the resume editor</Link>
        </p>
      </section>
    );
  }

  return (
    <section>
      {/* Outside #print-root, so hidden in print. */}
      <p>
        <Link href={`/jobs/${id}/resume`}>Back to editor</Link>
      </p>
      <PrintView draft={tailored.fullDraftMd} showPrintButton />
    </section>
  );
}
