'use client';

import { useState } from 'react';

import DraftConfirm from '@/app/(app)/library/_components/draft-confirm';
import EmptyMetricsBanner from '@/app/(app)/library/_components/empty-metrics-banner';
import ProjectCard from '@/app/(app)/library/_components/project-card';
import ProjectEditor from '@/app/(app)/library/_components/project-editor';
import UploadForm from '@/app/(app)/library/_components/upload-form';
import { saveLibrary, type ParseOk } from '@/app/(app)/library/_lib/api';
import { blankProject, newUid } from '@/app/(app)/library/_lib/library-edits';
import { Library, type Profile, type Project } from '@/lib/schemas/entities';

// LIB-03 — the client state machine behind /library (plan §2.9). `page.tsx` stays
// a thin server component; everything interactive lives here.
//
// THREE BRANCHES, in this order:
//   1. a parsed draft in hand   → <DraftConfirm>   (PRD §5.1: 草稿必须经用户确认才成为库)
//   2. no library               → <UploadForm>     (PRD §3 C1: 导入是主路径)
//   3. a library                → the confirmed page: EmptyMetricsBanner + cards
//                                 with ongoing add/edit/remove (PRD §5 S5 "复利":
//                                 the library keeps growing over the product's
//                                 lifetime, so this is not a one-shot onboarding
//                                 screen)
//
// NO `useRouter`, NO `router.refresh()`, NO `next/navigation` import. Mutations go
// through LIB-02's existing endpoint and this component trusts its echo, which
// keeps every test free of Next router mocks. The cost is recorded rather than
// hidden: `initialLibrary` is a SNAPSHOT, so a second browser tab will diverge and
// the later save wins — which is exactly LIB-02's own accepted last-write-wins
// ("single-user single-session usage pattern assumed"), inherited, not newly
// introduced here.
//
// NO per-project REST calls and no optimistic locking: LIB-02's whole-object
// upsert is the only write path there is, and adding endpoints is a ticket
// Non-goal. Every mutation below therefore posts the COMPLETE library.
//
// SINGLE-FLIGHT: while a save is in flight every mutating control is disabled.
// Overlapping mutations (edit-save then remove before the first response lands)
// would let the earlier echo resurrect state the user already changed (plan §4
// C3), and `libraries.userId` has no UNIQUE constraint to fall back on.
//
// RE-IMPORT IS DELIBERATELY ABSENT. The upload flow is reachable only while the
// user has no library. How a re-import should interact with `resumeMd` overwrite
// semantics is a future ticket's open question (this ticket's Feedback obligation
// #3) — not something to invent here.

type Row = { uid: string; project: Project };

/** Which row is open in an editor, and what to restore if the user cancels. */
type EditState = {
  uid: string;
  /** The pre-edit project, or `null` for a row that was just added (cancel drops it). */
  snapshot: Project | null;
};

const DANGER = '#b00020';

const toRows = (projects: readonly Project[]): Row[] =>
  projects.map((project) => ({ uid: newUid(), project }));

export default function LibraryWorkspace({
  initialLibrary,
  initialResumeMd,
}: {
  initialLibrary: Library | null;
  initialResumeMd: string | null;
}) {
  const [profile, setProfile] = useState<Profile | null>(initialLibrary?.profile ?? null);
  const [rows, setRows] = useState<Row[]>(() => toRows(initialLibrary?.projects ?? []));
  // `resumeMd === null` alongside a non-null library is unreachable through this
  // app's flows (LIB-02 writes both atomically in one transaction) but IS
  // representable in the DB, since nothing constrains the two tables together.
  // '' is sent rather than blocking every save: a user whose resume row went
  // missing can still curate their library, and LIB-02 accepts '' (no `.min(1)`).
  // The alternative — refusing to save — was rejected because it strands the user
  // with no in-app way out. Handed to the Reviewer as docs/plans/LIB-03.md §5 Q3.
  const [resumeMd, setResumeMd] = useState<string>(initialResumeMd ?? '');
  const [draft, setDraft] = useState<ParseOk | null>(null);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projects = rows.map((row) => row.project);

  /**
   * Post the whole library and adopt the echo. Returns whether it committed.
   *
   * On failure the on-screen state is left EXACTLY as the user left it — never
   * rolled back to the server value, which would make their edit vanish with no
   * explanation.
   */
  async function commit(nextRows: Row[]): Promise<boolean> {
    if (!profile) return false;
    setError(null);

    const parsed = Library.safeParse({ profile, projects: nextRows.map((r) => r.project) });
    if (!parsed.success) {
      setError(
        `Fix these before saving: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      );
      return false;
    }

    setBusy(true);
    setRows(nextRows);
    try {
      const result = await saveLibrary(parsed.data, resumeMd);
      if (!result.ok) {
        setError(result.message);
        return false;
      }
      // Adopt the echo, keeping each row's uid so open editors and React keys stay
      // stable. Positional mapping is sound because LIB-02 echoes back exactly the
      // array it persisted.
      setRows(
        result.library.projects.map((project, index) => ({
          uid: nextRows[index]?.uid ?? newUid(),
          project,
        })),
      );
      setProfile(result.library.profile);
      setResumeMd(result.resumeMd);
      return true;
    } finally {
      setBusy(false);
    }
  }

  function updateRow(uid: string, next: Project) {
    setRows((prev) => prev.map((row) => (row.uid === uid ? { uid, project: next } : row)));
  }

  function startEdit(row: Row) {
    setError(null);
    setEditing({ uid: row.uid, snapshot: row.project });
  }

  function cancelEdit() {
    if (editing) {
      const { uid, snapshot } = editing;
      setRows((prev) =>
        snapshot === null
          ? // A row that was never saved — cancelling drops it entirely.
            prev.filter((row) => row.uid !== uid)
          : prev.map((row) => (row.uid === uid ? { uid, project: snapshot } : row)),
      );
    }
    setEditing(null);
    setError(null);
  }

  async function saveEdit() {
    if (busy) return;
    const committed = await commit(rows);
    // Stay in the editor on failure so the user's work is still in front of them.
    if (committed) setEditing(null);
  }

  function addProject() {
    const row: Row = {
      uid: newUid(),
      project: blankProject(new Set(rows.map((r) => r.project.id))),
    };
    setRows((prev) => [...prev, row]);
    // Open it immediately, with snapshot null so Cancel removes it rather than
    // leaving an empty project behind. Nothing is persisted until Save.
    setEditing({ uid: row.uid, snapshot: null });
    setError(null);
  }

  async function removeProject(uid: string) {
    if (busy) return;
    await commit(rows.filter((row) => row.uid !== uid));
  }

  // ---- Branch 1: a parsed draft is waiting for confirmation -----------------
  if (draft) {
    return (
      <DraftConfirm
        draftLibrary={draft.draftLibrary}
        resumeMd={draft.resumeMd}
        onSaved={(library, savedResumeMd) => {
          setProfile(library.profile);
          setRows(toRows(library.projects));
          setResumeMd(savedResumeMd);
          setDraft(null);
        }}
      />
    );
  }

  // ---- Branch 2: no library yet — import is the main path -------------------
  if (!profile) {
    return (
      <section>
        <p>
          Import your resume to build your library. Parsing does the heavy lifting; you confirm
          and tweak each project afterwards, and you can add anything it missed by hand.
        </p>
        <p>
          Your uploaded file is never stored — it is read once, turned into text, and discarded.
        </p>
        <UploadForm onParsed={setDraft} />
      </section>
    );
  }

  // ---- Branch 3: the confirmed Library page --------------------------------
  return (
    <section>
      <EmptyMetricsBanner projects={projects} />

      {error ? (
        <p role="alert" style={{ color: DANGER }}>
          {error}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p>
          Your library has no projects yet. Add one to get started — you cannot create a job
          until your library has at least one project.
        </p>
      ) : null}

      {rows.map((row) =>
        editing?.uid === row.uid ? (
          <div key={row.uid}>
            <ProjectEditor
              uid={row.uid}
              project={row.project}
              disabled={busy}
              onChange={(next) => updateRow(row.uid, next)}
            />
            <p>
              <button type="button" onClick={saveEdit} disabled={busy}>
                Save changes
              </button>{' '}
              <button type="button" onClick={cancelEdit} disabled={busy}>
                Cancel
              </button>
            </p>
          </div>
        ) : (
          <ProjectCard
            key={row.uid}
            project={row.project}
            disabled={busy || editing !== null}
            onEdit={() => startEdit(row)}
            onRemove={() => void removeProject(row.uid)}
          />
        ),
      )}

      {busy ? <p role="status">Saving your library…</p> : null}

      <p>
        <button type="button" onClick={addProject} disabled={busy || editing !== null}>
          Add a project
        </button>
      </p>
    </section>
  );
}
