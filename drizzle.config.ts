import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './db/schema.ts',
  out: './db/migrations',
  dbCredentials: {
    // Only read when running commands that touch a live database (e.g.
    // `db:migrate`). `db:generate` is schema-file-only and never connects, so it
    // works with this left unset. The `?? ''` keeps drizzle-kit's config typecheck
    // happy without forcing a real URL at generate time.
    url: process.env.DATABASE_URL ?? '',
  },
});
