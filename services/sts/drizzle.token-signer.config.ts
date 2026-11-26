import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle.token-signer',
  schema: './src/db/token-signer-schema.ts',
  dialect: 'sqlite',
  driver: 'durable-sqlite',
});
