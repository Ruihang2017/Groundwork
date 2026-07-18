import Link from 'next/link';

// Public Terms of Service (PLT-01 Deliverable 1). Resolves to `/tos`, which
// middleware.ts (PLT-01 append) lists as public. Static Server Component — NO
// auth() call, NO data fetching, NO user-specific content (a public legal page
// must render identically for everyone; see plan §4).
//
// Standard-practice ToS sections (acceptable use, no warranty, termination,
// including a plain-language pointer to the same hard-delete mechanism the
// Privacy Policy describes). Legal adequacy is an explicit [human] acceptance
// item (Horace's review before public launch) — this is the honest draft that
// review starts from, not a self-certified final legal document. "Groundwork"
// is a working title (01-foundation open Q#1).
export const metadata = {
  title: 'Terms of Service — Groundwork',
};

const LAST_UPDATED = '2026-07-18';

export default function TermsOfServicePage() {
  return (
    <section style={{ maxWidth: '46rem', lineHeight: 1.6 }}>
      <h1>Terms of Service</h1>
      <p>
        <em>Last updated: {LAST_UPDATED}</em>
      </p>

      <p>
        These terms govern your use of Groundwork. By creating an account or
        using the service, you agree to them. Please also read our{' '}
        <Link href="/privacy">Privacy Policy</Link>, which explains how we handle
        your data.
      </p>

      <h2>The service</h2>
      <p>
        Groundwork helps you build a structured library of your real work
        experience and generate job-search outputs — fit reports, tailored resume
        drafts, and interview preparation — from it. The outputs are drafts and
        aids for your own judgment; you are responsible for reviewing everything
        before you rely on or submit it.
      </p>

      <h2>Your account</h2>
      <p>
        You must provide accurate information when signing in and are responsible
        for activity under your account. Provide only content you have the right
        to use.
      </p>

      <h2>Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>use the service for any unlawful purpose or to submit content you do
          not have the right to use;</li>
        <li>attempt to access another user&apos;s data or account, or to bypass
          the account isolation or usage limits built into the service;</li>
        <li>abuse, overload, reverse-engineer, or disrupt the service or the
          infrastructure it runs on.</li>
      </ul>
      <p>
        The service applies per-account usage quotas and cost limits. We may
        throttle or temporarily pause resource-intensive operations to keep the
        service available and its costs sustainable.
      </p>

      <h2>AI-generated content</h2>
      <p>
        Outputs are generated with the help of Anthropic&apos;s API and may
        contain errors or omissions. They are not professional, legal, or career
        advice. Always verify accuracy before using any output.
      </p>

      <h2>No warranty</h2>
      <p>
        The service is provided &quot;as is,&quot; without warranties of any
        kind, to the fullest extent permitted by law. We do not guarantee that it
        will be uninterrupted, error-free, or that any output will lead to a
        particular result.
      </p>

      <h2>Limitation of liability</h2>
      <p>
        To the fullest extent permitted by law, Groundwork is not liable for any
        indirect, incidental, or consequential damages arising from your use of
        the service.
      </p>

      <h2>Termination and deletion</h2>
      <p>
        You may stop using the service and permanently delete your account and
        all associated data at any time from your{' '}
        <Link href="/settings">account settings</Link> — deletion is immediate
        and irreversible, as described in our{' '}
        <Link href="/privacy">Privacy Policy</Link>. We may suspend or terminate
        accounts that violate these terms.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms as the service evolves. Continued use after an
        update means you accept the revised terms.
      </p>
    </section>
  );
}
