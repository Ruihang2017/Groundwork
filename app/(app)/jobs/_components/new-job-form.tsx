'use client';

import Link from 'next/link';
import { useState } from 'react';

// FIT-03 Deliverable 2 — the JD-paste form, and PRD §5.7's Jobs 列表 gate, quoted:
// "无库时禁止新建 job，CTA 引导导入简历——垃圾进垃圾出，库太薄时产出通用结果等于自毁
// 定位".
//
// PLAN D14 — this form lives INLINE on /jobs, not at a /jobs/new route. PRD §4 S2
// describes "全选粘贴 JD" — one paste, not a page.
//
// THE NO-LIBRARY GATE HERE IS UX, NOT A SECURITY BOUNDARY (plan R3). FIT-01's
// `POST /api/jobs` returns 403 `no_library` server-side and THAT is the real control —
// anyone can call the route directly. This client gate exists so the user is told why
// before they paste 6 000 characters, and the 403 branch below exists because this
// prop can be STALE (a tab left open across an account deletion).
//
// PLAN D3 — the "single Fit action". On 201 this does a FULL navigation to
// `/jobs/<id>`, where the Fit tab's auto-runner issues the second server call. Full
// navigation (`window.location.href`) rather than `useRouter().push()`: the exact
// precedent already in this repo is settings/_components/delete-account-confirm.tsx,
// and it keeps every test in this ticket free of a Next router mock. Cost: one extra
// document load between the two calls. Accepted and recorded.
//
// SINGLE-FLIGHT IS A COST CONTROL, NOT POLISH. One submit is one paid READ call plus
// one `fit` quota unit (~$0.04, PRD §9). `busy` disables the button AND the handler
// returns early, because a disabled button is not a guarantee — a double-click can
// dispatch both events before React re-renders. A test pins "exactly ONE fetch".
//
// NO `console.*` ANYWHERE. A pasted JD routinely carries the user's own annotations
// about the company, and FIT-01's logging rule forbids logging `jdRaw` server-side for
// exactly that reason. A test pins the absence.
//
// EVERY NON-201 PATH LEAVES THE FORM USABLE with the typed values intact. Losing a
// pasted job description to a transient error is a real user injury.

// Mirrors FIT-01's server-side caps (app/api/jobs/route.ts). These are UX mirrors that
// save a pointless round-trip and a confusing 400 — NOT security. The server's caps are
// the real ones and are trivially reachable without this form.
const MAX_JD_CHARS = 50_000;
const MAX_NAME_CHARS = 200;

const DANGER = '#b00020';

function NoLibraryGate() {
  return (
    <section style={{ margin: '0 0 2rem' }}>
      <h2 style={{ fontSize: '1.1rem', margin: '0 0 0.5rem' }}>Import your resume first</h2>
      <p style={{ margin: '0 0 0.5rem' }}>
        A job screened against an empty library produces generic output — which is worse
        than no output, because it looks like an answer.
      </p>
      <p style={{ margin: 0 }}>
        <Link href="/library">Import your resume</Link>
      </p>
    </section>
  );
}

export default function NewJobForm({ hasLibrary }: { hasLibrary: boolean }) {
  const [company, setCompany] = useState('');
  const [role, setRole] = useState('');
  const [jdRaw, setJdRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the SERVER says there is no library, overriding a stale prop.
  const [serverSaysNoLibrary, setServerSaysNoLibrary] = useState(false);

  if (!hasLibrary || serverSaysNoLibrary) return <NoLibraryGate />;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);

    // Client-side pre-checks bail with ZERO fetch calls — no paid round-trip and no
    // quota unit spent on an input the server would reject anyway.
    if (company.trim() === '' || role.trim() === '' || jdRaw.trim() === '') {
      setError('Fill in the company, the role, and the job description.');
      return;
    }
    if (company.length > MAX_NAME_CHARS || role.length > MAX_NAME_CHARS) {
      setError(`Company and role must each be ${MAX_NAME_CHARS} characters or fewer.`);
      return;
    }
    if (jdRaw.length > MAX_JD_CHARS) {
      setError(
        `That job description is longer than ${MAX_JD_CHARS.toLocaleString('en-US')} characters. Paste the posting itself, without the whole careers page.`,
      );
      return;
    }

    setBusy(true);
    try {
      // Relative, same-origin URL. `userId` is NEVER sent — the route takes it from
      // the session (PRD §8.3), and FIT-01's Zod strips any client-sent one anyway.
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jdRaw, company, role }),
      });

      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }

      if (res.status === 201) {
        const id = (body as { id?: unknown } | null)?.id;
        if (typeof id === 'string' && id !== '') {
          // D3: full navigation, so the Fit tab mounts fresh and its auto-runner
          // issues the second call.
          window.location.href = `/jobs/${id}`;
          return;
        }
        // Never navigate to /jobs/undefined.
        setError('The job was created but we could not open it. Reload this page to find it.');
        return;
      }

      setError(messageFor(res.status, body, () => setServerSaysNoLibrary(true)));
    } catch {
      // A network throw. No `console.*` — see the header.
      setError('We could not reach the server. Check your connection and try again.');
    } finally {
      // Always cleared, on every path, so the form stays usable and the typed values
      // are preserved.
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ margin: '0 0 2rem' }}>
      <h2 style={{ fontSize: '1.1rem', margin: '0 0 0.5rem' }}>Screen a new job</h2>

      <label htmlFor="new-job-company">Company</label>
      <input
        id="new-job-company"
        name="company"
        value={company}
        disabled={busy}
        onChange={(e) => setCompany(e.target.value)}
        style={{ display: 'block', margin: '0.25rem 0 0.75rem', width: '100%', maxWidth: '28rem' }}
      />

      <label htmlFor="new-job-role">Role</label>
      <input
        id="new-job-role"
        name="role"
        value={role}
        disabled={busy}
        onChange={(e) => setRole(e.target.value)}
        style={{ display: 'block', margin: '0.25rem 0 0.75rem', width: '100%', maxWidth: '28rem' }}
      />

      <label htmlFor="new-job-jd">Job description</label>
      <textarea
        id="new-job-jd"
        name="jdRaw"
        rows={12}
        value={jdRaw}
        disabled={busy}
        onChange={(e) => setJdRaw(e.target.value)}
        style={{ display: 'block', margin: '0.25rem 0 0.75rem', width: '100%' }}
      />

      {error ? (
        <p role="alert" style={{ color: DANGER }}>
          {error}
        </p>
      ) : null}

      {busy ? <p role="status">Reading the job description… this usually takes about 30 seconds.</p> : null}

      <p>
        {/* The label does NOT change while busy: swapping it would change the button's
            ACCESSIBLE NAME mid-action, which makes a screen reader re-announce a
            control the user did not move to. Progress lives in the role="status" line
            above — same reasoning as LIB-03's upload-form.tsx. */}
        <button type="submit" disabled={busy}>
          Screen this job
        </button>
      </p>
    </form>
  );
}

/**
 * FIT-01's wire contract, branch by branch. Every message tells the user what to DO;
 * none of them echoes a raw server value.
 */
function messageFor(status: number, body: unknown, onNoLibrary: () => void): string {
  const error = (body as { error?: unknown } | null)?.error;

  if (status === 403 && error === 'no_library') {
    // Reachable via a stale tab. Flip to the same CTA the `hasLibrary === false` prop
    // renders, rather than showing an error the user cannot act on.
    onNoLibrary();
    return 'You need a library before screening a job.';
  }
  if (status === 429) {
    // `resetAt` is a raw epoch number and is deliberately NOT echoed.
    return "You've used today's Fit allowance. Try again tomorrow.";
  }
  if (status === 422) {
    return "We couldn't read that job description. Check that you pasted the whole posting and try again.";
  }
  if (status === 400) {
    // Safe to surface: FIT-01 guarantees `issues` are Zod PATHS + messages and never
    // VALUES, precisely so they can be shown. Capped at 5. Do not extend this to
    // echoing arbitrary server error bodies.
    const issues = (body as { issues?: unknown } | null)?.issues;
    const shown = Array.isArray(issues)
      ? issues.filter((i): i is string => typeof i === 'string').slice(0, 5)
      : [];
    return shown.length > 0
      ? `That job could not be created: ${shown.join('; ')}`
      : 'That job could not be created. Check the fields above and try again.';
  }
  if (status === 401) {
    return 'Your session has expired. Sign in again to continue.';
  }
  if (status === 503) {
    return 'Job screening is temporarily unavailable. Please try again later.';
  }
  return 'We could not create that job. Nothing was saved — try again.';
}
