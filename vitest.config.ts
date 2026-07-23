import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Required (not optional) for the first .tsx/React-rendering test in this repo
  // (app/(auth)/signin/page.test.tsx, FND-09): tsconfig.json's "jsx":"preserve" is
  // SWC/Next.js-specific, so Vitest's own transform pipeline needs this plugin to
  // parse JSX in .tsx files. Matches Next.js's official Vitest guide. Pinned to 5.x
  // for vite 7 compat (v6 requires vite ^8) — see docs/plans/FND-09.md §2.6.
  plugins: [react()],
  test: {
    // Global environment stays 'node' (unchanged) — the one component test scopes
    // itself to jsdom via a `// @vitest-environment jsdom` file-level comment, so
    // every existing db/**, auth*, middleware test keeps its node environment.
    environment: 'node',
    // ISS-29, raised to a GLOBAL floor by PLT-04. Vitest's default hookTimeout is
    // 10_000ms; a PGlite boot + the real migration chain routinely exceeds that once
    // enough suites contend for the box. The established remedy is a per-hook third
    // argument (lib/db/queries/admin.test.ts:46 explains why that is the only
    // placement Vitest binds) — but three files that predate the convention rely on
    // the default instead (lib/config/quota.test.ts, lib/usage/record.test.ts,
    // eval/report.test.ts), and PLT-04's two new PGlite-backed suites pushed them
    // over it. Raising the floor here fixes all three WITHOUT editing them (they are
    // regression guards owned by other tickets and stay byte-for-byte unmodified).
    // This only relaxes a deadline — it changes no assertion and can turn no red test
    // green. Per-hook third arguments remain the convention for new files; this is
    // the safety net beneath them.
    hookTimeout: 30_000,
    // `*.test.ts` (repo root) added by FND-08 so root-colocated middleware.test.ts /
    // auth.config.test.ts are discovered — the existing tests/**, lib/**, db/**
    // globs don't reach a root-level test file. (Same false-green failure mode
    // FND-02/FND-05 fixed for their own new test locations.) `app/**/*.test.{ts,tsx}`
    // added by FND-09 for the sign-in page component test — none of the prior globs
    // reach app/**.
    include: [
      'tests/**/*.test.ts',
      'lib/**/*.test.ts',
      'db/**/*.test.ts',
      '*.test.ts',
      'app/**/*.test.{ts,tsx}',
      // `fixtures/**/*.test.ts` added by EVL-01 so the new manifest test
      // (fixtures/manifest.test.ts) is discovered — none of the prior globs
      // reach fixtures/**. Same false-green failure mode FND-02/05/06/08/09
      // each fixed for their own new test locations.
      'fixtures/**/*.test.ts',
      // `eval/**/*.test.ts` added by EVL-02 so eval/**'s new test files are
      // discovered — none of the prior globs reach eval/**. Same false-green
      // failure mode every prior FND/EVL ticket fixed for its own test location.
      'eval/**/*.test.ts',
    ],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
});
