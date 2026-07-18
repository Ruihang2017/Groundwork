import Link from 'next/link';

// Public landing page (FND-09 Deliverable 2). Resolves to `/`, which middleware.ts
// (FND-08) hard-codes as public. Copy is an English rendering of PRD §0's one-liner
// per PRD §5.8's "UI 英文" mandate; product name "Groundwork" is a working title
// (01-foundation/README.md open question #1, owner Horace) — not final branding.
// The header (app/layout.tsx) renders the sign-in state, so no auth() call is
// needed here — this page stays static-content-only.
export default function Home() {
  return (
    <section style={{ maxWidth: '42rem' }}>
      <h1>Groundwork</h1>
      <p>
        Turn your real experience into a structured background library — and turn
        that library into a defensible output at every step of the job search.
      </p>
      <p>
        <Link href="/signin">Get started</Link>
      </p>
    </section>
  );
}
