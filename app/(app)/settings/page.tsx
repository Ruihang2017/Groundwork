import DeleteAccountConfirm from '@/app/(app)/settings/_components/delete-account-confirm';

// Settings page (PLT-01 Deliverable 3). Lives under app/(app)/**, so it is
// automatically behind middleware.ts's default auth gate (the gate is an
// allowlist-by-omission: any path not in PUBLIC_PATHS is protected the moment it
// exists — no per-page code needed, same as app/(app)/home/page.tsx).
//
// Kept as a minimal sync Server Component that just hosts the destructive action
// — the header (app/layout.tsx) already renders who is signed in, so this page
// needs no auth() call of its own (plan §2.3: greeting is an optional
// nice-to-have, deliberately skipped to keep the page trivially renderable).
export const metadata = {
  title: 'Account settings — Groundwork',
};

export default function SettingsPage() {
  return (
    <section style={{ maxWidth: '32rem' }}>
      <h1>Account settings</h1>

      <h2 style={{ marginTop: '2rem', color: '#b00020' }}>Danger zone</h2>
      <DeleteAccountConfirm />
    </section>
  );
}
