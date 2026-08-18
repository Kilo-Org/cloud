import { type Plugin } from 'vitest/config';

/**
 * Inlines `.sql` files as default-exported strings, the same way
 * babel-plugin-inline-import does in the Metro bundle. Without it,
 * `drizzle/migrations.js` cannot import the generated migrations under vitest.
 */
export function inlineSqlPlugin(): Plugin {
  return {
    name: 'inline-sql',
    transform(code, id) {
      if (!id.endsWith('.sql')) {
        return null;
      }
      return { code: `export default ${JSON.stringify(code)};`, map: null };
    },
  };
}
