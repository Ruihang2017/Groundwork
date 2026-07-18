'use client';

import { useState } from 'react';

// Client component hosting the irreversible "Delete my account" action (PLT-01
// Deliverable 3). The ticket leaves the exact confirmation UX to this ticket's
// judgment; the pattern chosen (plan §2.3, Open Q#3) is a two-step disclosure
// standard for destructive actions:
//   1. A "Delete my account" button reveals an inline warning + a text input.
//   2. The final, destructive submit button stays DISABLED until the user types
//      the exact confirmation phrase.
// On submit it POSTs to /api/account/delete (the route derives userId from the
// session — this component sends NO userId, per the trust boundary in plan
// §2.2/§2.3). On success the session is now dead, so it does a FULL navigation
// to '/' (not a client-side router push, which would 401 against stale state).
// On failure it shows an inline error and leaves the account intact.

const CONFIRM_PHRASE = 'DELETE';

export default function DeleteAccountConfirm() {
  const [revealed, setRevealed] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = phrase === CONFIRM_PHRASE && !submitting;

  async function handleDelete() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/account/delete', { method: 'POST' });
      const body = (await res.json().catch(() => null)) as
        | { deleted?: boolean }
        | null;
      if (res.ok && body?.deleted) {
        // Session is gone — hard-navigate away so nothing runs against a dead
        // session. Full navigation, not a router push.
        window.location.href = '/';
        return;
      }
      setError('Account deletion failed. Your account has not been changed.');
      setSubmitting(false);
    } catch {
      setError('Account deletion failed. Your account has not been changed.');
      setSubmitting(false);
    }
  }

  if (!revealed) {
    return (
      <div>
        <p>
          Permanently delete your account and all of your data. This cannot be
          undone.
        </p>
        <button type="button" onClick={() => setRevealed(true)}>
          Delete my account
        </button>
      </div>
    );
  }

  return (
    <div>
      <p role="alert" style={{ color: '#b00020' }}>
        This permanently and immediately deletes your library, resumes, jobs,
        tailored drafts, interview briefs, usage history, and your account
        itself. This cannot be undone.
      </p>

      <label htmlFor="confirm-phrase">
        Type <strong>{CONFIRM_PHRASE}</strong> to confirm
      </label>
      <input
        id="confirm-phrase"
        name="confirm-phrase"
        type="text"
        autoComplete="off"
        value={phrase}
        onChange={(e) => setPhrase(e.target.value)}
        style={{ display: 'block', margin: '0.5rem 0' }}
      />

      {error ? (
        <p role="alert" style={{ color: '#b00020' }}>
          {error}
        </p>
      ) : null}

      <button
        type="button"
        disabled={!canSubmit}
        onClick={handleDelete}
        style={{ color: '#b00020' }}
      >
        {submitting ? 'Deleting…' : 'Permanently delete my account'}
      </button>{' '}
      <button
        type="button"
        onClick={() => {
          setRevealed(false);
          setPhrase('');
          setError(null);
        }}
        disabled={submitting}
      >
        Cancel
      </button>
    </div>
  );
}
