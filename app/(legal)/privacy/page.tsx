import Link from 'next/link';

// Public Privacy Policy (PLT-01 Deliverable 1). Resolves to `/privacy`, which
// middleware.ts (PLT-01 append) lists as public so logged-out visitors can read
// it before signing up. Static Server Component — NO auth() call, NO data
// fetching, NO user-specific content (a public legal page must render identically
// for everyone; see plan §4 "Legal pages are public by design").
//
// Every factual claim below is TRUE of what this codebase actually builds, per
// PRD §8.3 and traceable to a concrete, merged mechanism (plan §2.5):
//   - account-scoped queries → lib/auth/session.ts requireUserId() + userId
//     scoping on every table in db/schema.ts
//   - no resume-file storage → resumes table has no blob/file column, only
//     parsed `sourceMd` text (db/schema.ts comment: "originals are discarded
//     after parse")
//   - Anthropic-only third-party processor → ANTHROPIC_API_KEY in .env.example,
//     zero analytics SDKs in package.json
//   - hard delete on request → app/api/account/delete/route.ts (this ticket)
//   - own usage_events, no third-party analytics → lib/usage/record.ts
//
// Legal adequacy of this copy is an explicit [human] acceptance item (Horace's
// review before public launch); this file is the honest, accurate draft that
// review starts from. "Groundwork" is a working title (01-foundation open Q#1).
export const metadata = {
  title: 'Privacy Policy — Groundwork',
};

const LAST_UPDATED = '2026-07-18';

export default function PrivacyPolicyPage() {
  return (
    <section style={{ maxWidth: '46rem', lineHeight: 1.6 }}>
      <h1>Privacy Policy</h1>
      <p>
        <em>Last updated: {LAST_UPDATED}</em>
      </p>

      <p>
        Groundwork helps you turn your real work experience into a structured
        background library and defensible job-search outputs. This policy
        explains what data we hold, how we use it, who else can see it, and how
        you can delete it. It describes what the product actually does — not
        aspirations.
      </p>

      <h2>What we store</h2>
      <ul>
        <li>
          <strong>Your account.</strong> Your email address, and (if you sign in
          with Google) your name and profile image, so we can identify you and
          sign you in.
        </li>
        <li>
          <strong>Your background library.</strong> The structured profile and
          projects you build, and the parsed text of any resume you provide.
        </li>
        <li>
          <strong>Your jobs and outputs.</strong> Job descriptions you add and
          the fit reports, tailored drafts, and interview-prep material we
          generate for them.
        </li>
        <li>
          <strong>Usage records.</strong> Per-operation records (which action,
          when, token counts, cost, duration) stored in our own database. We use
          these only to enforce fair-use quotas and control costs — not for
          advertising or profiling.
        </li>
      </ul>

      <h2>What we do not store</h2>
      <p>
        We do not keep your original uploaded resume file. When you provide a
        resume, we parse it to text and discard the original — there is no file
        or blob stored on our side, only the parsed text you can see and edit.
      </p>

      <h2>How your data is isolated</h2>
      <p>
        Every query the application makes is scoped to your own account. There is
        no path in the product that returns another user&apos;s data, and no user
        can read yours.
      </p>

      <h2>Who else processes your data</h2>
      <p>
        To generate fit reports, tailored drafts, and interview prep, we send the
        relevant text to <strong>Anthropic&apos;s API</strong>. Anthropic is the
        only third-party processor of your content. We do{' '}
        <strong>not</strong> integrate any third-party analytics, advertising, or
        tracking services; the usage records described above live only in our own
        database.
      </p>

      <h2>Deleting your account and data</h2>
      <p>
        You can permanently delete your account at any time from your{' '}
        <Link href="/settings">account settings</Link>. Deletion is immediate and
        irreversible: it hard-deletes all of your data — your library, resumes,
        jobs, tailored drafts, interview briefs, usage records, and your account
        itself. We do not keep a soft-deleted or recoverable copy after you
        delete your account.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this policy or your data can be raised with the
        Groundwork team. See also our <Link href="/tos">Terms of Service</Link>.
      </p>
    </section>
  );
}
