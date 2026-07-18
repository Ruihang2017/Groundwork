import Link from 'next/link';
import type { ReactNode } from 'react';

import { auth, signOut } from '@/auth';

// This root layout reads live per-request auth state (`auth()` below), so there is
// no meaningful static version of it. Declaring `force-dynamic` documents that
// intent explicitly and removes any reliance on next-auth's internal
// dynamic-API-bailout ordering to keep `next build` DB-free — see docs/plans/FND-09.md
// §0.4/§2.1 (belt-and-suspenders on top of auth.ts's request-time buildAuthConfig).
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Groundwork',
  description:
    'Turn your real experience into a structured background library — and a defensible output at every step of the job search.',
};

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await auth();

  return (
    <html lang="en">
      <body>
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0.75rem 1.25rem',
            borderBottom: '1px solid #ddd',
            gap: '1rem',
          }}
        >
          <Link href="/" style={{ fontWeight: 600 }}>
            Groundwork
          </Link>

          {session?.user ? (
            // Signed-out control: an inline Server Action calling @/auth's
            // server-only signOut() — the documented Auth.js v5 App Router pattern
            // (no client JS needed). Safe to import @/auth's signOut here (unlike
            // the sign-in page, which must use next-auth/react — see
            // docs/plans/FND-09.md §0.3): inline Server Actions never run during
            // `next build`, only on a real POST at runtime, so signOut()'s
            // next/headers dependency never executes at build time.
            <form
              action={async () => {
                'use server';
                await signOut({ redirectTo: '/' });
              }}
              style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}
            >
              <span>{session.user.name ?? session.user.email}</span>
              <button type="submit">Sign out</button>
            </form>
          ) : (
            <Link href="/signin">Sign in</Link>
          )}
        </header>

        <main style={{ padding: '1.25rem' }}>{children}</main>
      </body>
    </html>
  );
}
