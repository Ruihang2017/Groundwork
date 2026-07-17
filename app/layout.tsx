// FND-09 replaces this — see docs/prd/01-foundation/tickets/FND-09-app-shell-deploy.md
// Placeholder root layout created by FND-01 only so `next build` succeeds; no app-shell content here.
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
