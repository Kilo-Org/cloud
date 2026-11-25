import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle.denial',
  schema: './src/db/denial-schema.ts',
  dialect: 'sqlite',
  driver: 'durable-sqlite',
});
