import { defineConfig } from 'drizzle-kit';

// Separate Drizzle config so B3 can generate routes migrations for the V2
// Sandbox DO without touching the shared `drizzle/` folder.
export default defineConfig({
  out: './src/control-plane/sandbox/drizzle',
  schema: './src/control-plane/sandbox/sqlite-schema.ts',
  dialect: 'sqlite',
  driver: 'durable-sqlite',
});
