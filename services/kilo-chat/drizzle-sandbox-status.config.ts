import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  out: './drizzle/sandbox-status',
  schema: './src/db/sandbox-status-schema.ts',
  dialect: 'sqlite',
  driver: 'durable-sqlite',
});
