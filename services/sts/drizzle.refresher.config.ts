import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle.refresher',
  schema: './src/db/refresher-schema.ts',
  dialect: 'sqlite',
  driver: 'durable-sqlite',
});
