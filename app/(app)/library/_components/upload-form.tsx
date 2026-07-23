'use client';

import { useState } from 'react';

import { requestParse, type ParseOk } from '@/app/(app)/library/_lib/api';

// LIB-03 Deliverable 1 — the import entry point.
//
// PRD §5.1 (PARSE row): 导入简历 · 文件/文本 → resumeMd + 草稿 Library, and the
// failure policy "解析失败 → 引导粘贴纯文本" — on a 422 carrying `suggestPaste`,
// this form switches to plain-text paste rather than showing an error page.
//
// STREAMING — a deliberate, narrower reading of PRD §5.1, recorded here because
// the ticket's Deliverable 1 requires it to be recorded rather than left implicit:
// §5.1's streaming requirement and delay budget ("全程 streaming 展示进度") name
// Fit / Tailor / Prep only. PARSE has NO named streaming requirement, so a plain
// loading state is a deliberate narrower reading of §5.1, not an oversight. The
// loading copy is honest about the wait instead (PRD §4 S1 says "约 30s").
//
// COST — the submit button is disabled while a parse is in flight, and that is a
// cost control, not polish. PARSE deliberately has NO per-user quota bucket
// (LIB-01: `DAILY_QUOTA` has no `parse` key); the 10 MiB cap and the GLOBAL spend
// breaker are the entire backstop. A double-clicked upload is a genuine double
// Anthropic charge (~$0.03 each, PRD §9) and 60–80s of serverless time.
//
// PRIVACY — the selected `File` is held in component state only for the lifetime
// of this component, passed straight to `fetch`, and never read into a string,
// never persisted to localStorage/sessionStorage/IndexedDB, never logged. PRD
// §8.1's "原始文件解析后即弃、不落盘" is a published promise on the live
// app/(legal)/privacy/page.tsx.

// Mirrors LIB-01's server-side MAX_UPLOAD_BYTES. This client check is UX (it saves
// a pointless upload and a confusing 422), NOT security — the server cap is the
// real control and this one is trivially bypassable.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const ACCEPT =
  '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const DANGER = '#b00020';

export default function UploadForm({ onParsed }: { onParsed: (result: ParseOk) => void }) {
  const [mode, setMode] = useState<'file' | 'text'>('file');
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasteSuggested, setPasteSuggested] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);

    // Build the request input up front so the client-side pre-checks can bail
    // with ZERO fetch calls — no paid round-trip for an empty or oversized input.
    let input: { file: File } | { text: string };
    if (mode === 'file') {
      if (!file) {
        setError('Choose a PDF or DOCX file first, or paste the text instead.');
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        setError('That file is larger than 10 MB. Upload a smaller file or paste the text instead.');
        return;
      }
      input = { file };
    } else {
      if (text.trim() === '') {
        setError('Paste the text of your resume first.');
        return;
      }
      input = { text };
    }

    setBusy(true);
    try {
      const result = await requestParse(input);

      if (result.ok) {
        onParsed(result);
        return;
      }

      if (result.suggestPaste) {
        if (mode === 'text') {
          // Already pasting — "switching" to the mode the user is in is a silent
          // no-op that reads as a broken button (plan §4 E10).
          setError(
            "We couldn't read that text either. Check that you pasted the whole resume, then try again.",
          );
        } else {
          setMode('text');
          setPasteSuggested(true);
          setError(result.message);
        }
        return;
      }

      setError(result.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      {mode === 'file' ? (
        <div>
          <label htmlFor="resume-file">Resume file (PDF or DOCX)</label>
          <input
            id="resume-file"
            name="resume-file"
            type="file"
            // A UX hint only. LIB-01's route SNIFFS the content (%PDF- / PK\x03\x04)
            // and ignores file.type and file.name entirely, so this attribute is
            // never a guarantee about what the server will accept.
            accept={ACCEPT}
            disabled={busy}
            // The File is stored in STATE, which is what lets _lib/api.ts build the
            // multipart body by hand. `new FormData(formElement)` would lose it
            // under jsdom (plan §0 fact 3 / §4 E11).
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            style={{ display: 'block', margin: '0.25rem 0 0.75rem' }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setMode('text');
              setError(null);
            }}
          >
            Paste text instead
          </button>
        </div>
      ) : (
        <div>
          <label htmlFor="resume-text">Resume text</label>
          <textarea
            id="resume-text"
            name="resume-text"
            rows={12}
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            style={{ display: 'block', width: '100%', margin: '0.25rem 0 0.75rem' }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setMode('file');
              setError(null);
            }}
          >
            Upload a file instead
          </button>
        </div>
      )}

      {pasteSuggested ? (
        <p>
          Paste the plain text of your resume into the box above and try again — that path does
          not depend on reading the file.
        </p>
      ) : null}

      {error ? (
        <p role="alert" style={{ color: DANGER }}>
          {error}
        </p>
      ) : null}

      {busy ? <p role="status">Reading your resume… this usually takes about 30 seconds.</p> : null}

      <p>
        {/*
          The label stays "Import resume" while busy ON PURPOSE. Swapping it to
          "Reading…" would change the button's ACCESSIBLE NAME mid-action, which
          makes a screen reader re-announce a control the user did not move to —
          and makes the control unaddressable by its own name. Progress lives in
          the role="status" line above, which is what that role is for; the
          disabled state carries the rest.
        */}
        <button type="submit" disabled={busy}>
          Import resume
        </button>
      </p>
    </form>
  );
}
