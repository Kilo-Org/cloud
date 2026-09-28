import { defineConfig } from 'drizzle-kit';

/**
 * Authoring only. `pnpm migrations` runs drizzle-kit to write the SQL under
 * `migrations/`, then inlines it into `src/plugins/store/migrations.ts`.
 *
 * Nothing at runtime reads this file or the SQL on disk. React Native has no
 * filesystem to read migrations from, and Drizzle's answer there is a bundler
 * plugin, which a package must not force on everyone who installs it.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/plugins/store/schema.ts',
  out: './migrations',
});
