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
    ],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
});
