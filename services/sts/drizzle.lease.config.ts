import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle.lease',
  schema: './src/db/lease-schema.ts',
  dialect: 'sqlite',
  driver: 'durable-sqlite',
});
