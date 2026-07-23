import ResumeWorkspace from '@/app/(app)/jobs/[id]/resume/_components/resume-workspace';
import TailorGenerator from '@/app/(app)/jobs/[id]/resume/_components/tailor-generator';
import { projectNameMap } from '@/app/(app)/jobs/[id]/resume/_lib/project-names';
import { requireUserId } from '@/lib/auth/session';
import { getLibrary } from '@/lib/db/queries/library';
import { getTailoredResume } from '@/lib/db/queries/tailored-resumes';

// TLR-02 Deliverable 7 (plan §3.14) — the RESUME TAB, rendered inside FIT-03's job-detail
// shell (`[id]/layout.tsx`). Two branches:
//   no TailoredResume yet → <TailorGenerator> (the click-to-generate trigger, D4).
//   a draft exists        → <ResumeWorkspace>  (alignment + edits + editor + export).
//
// DOES NOT call `getJob`/`notFound()`: the parent `[id]/layout.tsx` (FIT-03) already guards
// the job's existence + ownership before any child page renders (plan §0). Re-reading here
// would be a third per-request primary-key read.
//
// `getTailoredResume` returns null for "no draft", "unknown job", AND "another user's job"
// — indistinguishable by design (PRD §8.3). On the reload path `dropped` is not persisted,
// so the workspace is handed `[]` / `0` and the dropped header renders nothing (plan R7).
//
// `getLibrary` MAY THROW on stored-row drift (LIB-02's loud-failure policy) — NOT caught
// (plan §3.14). `requireUserId` throws `UnauthorizedError` — propagated, not wrapped.
//
// STATIC import of the query modules: both are import-safe with `DATABASE_URL` unset (they
// lazy-resolve `@/db/index`), pinned by the build-guard test — exactly as [id]/page.tsx does.

export const dynamic = 'force-dynamic';

export default async function ResumePage({ params }: { params: Promise<{ id: string }> }) {
  // Next 15 hands `params` as a Promise; a non-Promise type fails `next build`'s route-type check.
  const { id } = await params;
  const userId = await requireUserId();

  const library = await getLibrary(userId);
  const projectNames = projectNameMap(library);

  const tailored = await getTailoredResume(userId, id);

  if (tailored === null) {
    return <TailorGenerator jobId={id} projectNames={projectNames} />;
  }

  return (
    <ResumeWorkspace
      jobId={id}
      tailored={tailored}
      projectNames={projectNames}
      // Reload path: `dropped` is not persisted, so the header renders nothing.
      droppedItems={[]}
      droppedCount={0}
    />
  );
}
