import { defineConfig } from 'drizzle-kit';

// Separate Drizzle config so B4 can generate the V2 Session DO's own migrations
// (message rows plus the shared events table) without touching the shared
// `drizzle/` folder.
export default defineConfig({
  out: './src/control-plane/session/drizzle',
  schema: './src/control-plane/session/sqlite-schema.ts',
  dialect: 'sqlite',
  driver: 'durable-sqlite',
});
