import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  out: './drizzle/conversation',
  schema: './src/db/conversation-schema.ts',
  dialect: 'sqlite',
  driver: 'durable-sqlite',
});
