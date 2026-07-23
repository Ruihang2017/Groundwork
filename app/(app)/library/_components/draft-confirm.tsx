'use client';

import { useState } from 'react';

import EmptyMetricsBanner from '@/app/(app)/library/_components/empty-metrics-banner';
import ProjectEditor from '@/app/(app)/library/_components/project-editor';
import { saveLibrary } from '@/app/(app)/library/_lib/api';
import { blankProject, newUid } from '@/app/(app)/library/_lib/library-edits';
import { Library, type Project } from '@/lib/schemas/entities';

// LIB-03 Deliverable 2 — the draft confirmation step.
//
// PRD §5.1 (PARSE row): "草稿必须经用户确认才成为库" — a draft becomes a library
// ONLY here. LIB-01's /api/parse persists nothing.
// PRD §4 S1: "逐条确认/微调" — the user reviews and edits projects ITEM BY ITEM,
// which is why this is a list of editable cards and not an accept-all button.
// PRD §3 C1: "手工填写只是补充与深化" — hence "Add a project" alongside the
// imported ones, not instead of them.
//
// THE PASS-THROUGH INVARIANT (ticket acceptance item 1): `resumeMd` arrives from
// PARSE and is submitted to LIB-02 BYTE-FOR-BYTE UNCHANGED, alongside whatever
// the user edited in `draftLibrary`. It is held as state and is NEVER placed in a
// form field — a <textarea> or hidden input would normalise `\r\n` to `\n` on
// submit and quietly break that invariant (plan §4 E7). It is also never
// rendered: v1 has no PRD-named user action that edits it (ticket Non-goals).
//
// ROW IDENTITY: each row carries a `uid` from `newUid()`, and THAT — never
// `project.id`, never the array index — is the React key and the DOM-id prefix.
// PARSE can emit duplicate `Project.id`s (LIB-01 §4 R7 — uniqueness is enforced
// nowhere), and index keys cross-wire inputs when a middle card is removed
// (plan §4 E2/E3). Duplicate ids are TOLERATED here, never silently rewritten:
// rewriting a model-produced id could merge or rename two genuinely different
// projects.
//
// SINGLE-FLIGHT SAVE: the confirm button is disabled while a save is in flight.
// This is not cosmetic — `libraries.userId` has NO UNIQUE constraint (LIB-02),
// so two simultaneous confirms are a duplicate-ROW risk, which LIB-02 mitigates
// server-side with an advisory lock but which the client should not provoke.
//
// ON SAVE FAILURE the user's edits stay on screen. Losing them is exactly the
// friction the ticket's Feedback obligation #1 is about; if it ever becomes
// unavoidable under LIB-02's whole-object upsert, that escalates to
// docs/prd/03-library/README.md's decisions table rather than being papered over
// in client state here.

type Row = { uid: string; project: Project };

const DANGER = '#b00020';

export default function DraftConfirm({
  draftLibrary,
  resumeMd,
  onSaved,
}: {
  draftLibrary: Library;
  /** The PARSE response's `resumeMd`, submitted unmodified. Never rendered. */
  resumeMd: string;
  onSaved: (library: Library, resumeMd: string) => void;
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    draftLibrary.projects.map((project) => ({ uid: newUid(), project })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);

  // `profile` is passed through unedited in v1: the ticket's Deliverable 2
  // enumerates project fields only, and no PRD line names a profile-editing
  // action. Recorded as an open question for the dogfood pass
  // (docs/plans/LIB-03.md §5 Q2), not silently dropped.
  const profile = draftLibrary.profile;
  const projects = rows.map((row) => row.project);

  function updateRow(uid: string, next: Project) {
    setRows((prev) => prev.map((row) => (row.uid === uid ? { uid, project: next } : row)));
  }

  function removeRow(uid: string) {
    setRows((prev) => prev.filter((row) => row.uid !== uid));
  }

  function addRow() {
    setRows((prev) => [
      ...prev,
      { uid: newUid(), project: blankProject(new Set(prev.map((r) => r.project.id))) },
    ]);
  }

  async function handleConfirm() {
    if (busy) return;
    setError(null);
    setIssues([]);

    const next = { profile, projects } satisfies Library;

    // Client-side validation FIRST, so LIB-02's opaque 400 becomes a field-level
    // message and a doomed request is never sent. The server check remains the
    // real trust boundary (PRD §5.5) — this is a UX layer over it, not a
    // replacement for it.
    const parsed = Library.safeParse(next);
    if (!parsed.success) {
      setIssues(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));
      return;
    }

    setBusy(true);
    try {
      const result = await saveLibrary(parsed.data, resumeMd);
      if (result.ok) {
        onSaved(result.library, result.resumeMd);
        return;
      }
      setError(result.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Confirm your library</h2>
      <p>
        This is a draft, not your library yet. Review each project, fix anything the parser got
        wrong, and add the real numbers it missed — nothing is saved until you confirm.
      </p>

      <EmptyMetricsBanner projects={projects} />

      {rows.length === 0 ? (
        <p>
          No projects were found in that resume. That is a valid result — add one manually below,
          or go back and paste a fuller version of your resume.
        </p>
      ) : null}

      {rows.map((row) => (
        <ProjectEditor
          key={row.uid}
          uid={row.uid}
          project={row.project}
          disabled={busy}
          onChange={(next) => updateRow(row.uid, next)}
          onRemove={() => removeRow(row.uid)}
        />
      ))}

      <p>
        <button type="button" onClick={addRow} disabled={busy}>
          Add a project
        </button>
      </p>

      {issues.length > 0 ? (
        <div role="alert" style={{ color: DANGER }}>
          <p>Fix these before saving:</p>
          <ul>
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {error ? (
        <p role="alert" style={{ color: DANGER }}>
          {error}
        </p>
      ) : null}

      {busy ? <p role="status">Saving your library…</p> : null}

      <p>
        <button type="button" onClick={handleConfirm} disabled={busy}>
          Confirm and save
        </button>
      </p>
    </section>
  );
}
