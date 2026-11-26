import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle.deploy-token',
  schema: './src/db/deploy-token-schema.ts',
  dialect: 'sqlite',
  driver: 'durable-sqlite',
});
