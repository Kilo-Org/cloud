import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  out: './drizzle',
  schema: './src/db/*.ts',
  dialect: 'sqlite',
  driver: 'durable-sqlite',
});
