import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // `*.test.ts` (repo root) added by FND-08 so root-colocated middleware.test.ts /
    // auth.config.test.ts are discovered — the existing tests/**, lib/**, db/**
    // globs don't reach a root-level test file. (Same false-green failure mode
    // FND-02/FND-05 fixed for their own new test locations.)
    include: [
      'tests/**/*.test.ts',
      'lib/**/*.test.ts',
      'db/**/*.test.ts',
      '*.test.ts',
    ],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
});
