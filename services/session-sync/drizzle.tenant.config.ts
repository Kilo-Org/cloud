import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle-tenant',
  schema: './src/db/tenant-sqlite-schema.ts',
  dialect: 'sqlite',
  driver: 'durable-sqlite',
});
