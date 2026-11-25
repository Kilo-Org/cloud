import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle.signer',
  schema: './src/db/signer-schema.ts',
  dialect: 'sqlite',
  driver: 'durable-sqlite',
});
