import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle.bundle',
  schema: './src/db/bundle-schema.ts',
  dialect: 'sqlite',
  driver: 'durable-sqlite',
});
