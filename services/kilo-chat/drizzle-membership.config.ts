import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  out: './drizzle/membership',
  schema: './src/db/membership-schema.ts',
  dialect: 'sqlite',
  driver: 'durable-sqlite',
});
