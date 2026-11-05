import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle-presence',
  schema: './src/db/presence-sqlite-schema.ts',
  dialect: 'sqlite',
  driver: 'durable-sqlite',
});
