import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle/vercel-snapshot',
  schema: './src/db/vercel-snapshot-schema.ts',
  dialect: 'sqlite',
  driver: 'durable-sqlite',
});
