import { defineConfig } from 'drizzle-kit';

// The EnvironmentBuild Durable Object owns its own SQLite schema and migrations.
export default defineConfig({
  out: './src/environment-build/drizzle',
  schema: './src/environment-build/sqlite-schema.ts',
  dialect: 'sqlite',
  driver: 'durable-sqlite',
});
