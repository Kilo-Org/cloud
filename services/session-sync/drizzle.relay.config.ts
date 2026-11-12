import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle-relay',
  schema: './src/db/relay-sqlite-schema.ts',
  dialect: 'sqlite',
  driver: 'durable-sqlite',
});
