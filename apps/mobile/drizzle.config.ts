import { defineConfig } from 'drizzle-kit';

// Regenerate after any change to src/lib/persist/schema.ts:
//   node node_modules/drizzle-kit/bin.cjs generate
// Then run `pnpm -w run format` — the generated `drizzle/migrations.js` is not
// oxfmt-formatted on output, and the root format check covers it.
export default defineConfig({
  dialect: 'sqlite',
  driver: 'expo',
  schema: './src/lib/persist/schema.ts',
  out: './drizzle',
});
