import { defineConfig } from 'vitest/config';

/**
 * The container suite: builds the image from container/ and runs it against Supabase's Postgres
 * images in Docker (member mode on SUPABASE_PG_IMAGE, default supabase/postgres:15.8.1.135;
 * direct mode on supabase/postgres:17.6.1.127). Needs Docker; not part of `pnpm test`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/container/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
