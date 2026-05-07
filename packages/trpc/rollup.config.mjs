import dts from 'rollup-plugin-dts';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tscOut = path.resolve(__dirname, 'dist/tsc');

// Resolve a path to a .d.ts file, trying both <path>.d.ts and <path>/index.d.ts
function resolveDts(base) {
  const asFile = base + '.d.ts';
  if (existsSync(asFile)) return asFile;
  const asIndex = path.join(base, 'index.d.ts');
  if (existsSync(asIndex)) return asIndex;
  return asFile; // fall through — let rollup report
}

export default {
  // @kilocode/encryption is type-only and never exposed in router I/O, so we
  // externalize it to avoid relying on tsgo emitting its transitive d.ts files
  // (which has been flaky in CI). Any unused imports get pruned by rollup's
  // tree-shaking, so the final bundle is unchanged.
  external: ['pg', '@tanstack/react-query', '@trpc/client', 'next/server', '@kilocode/encryption'],
  input: './dist/tsc/packages/trpc/src/index.d.ts',
  output: {
    file: './dist/index.d.ts',
    format: 'es',
    banner: '// Auto-generated — do not edit. Rebuild with: pnpm --filter @kilocode/trpc run build',
  },
  plugins: [
    {
      name: 'resolve-aliases',
      resolveId(source) {
        // Resolve @/* path aliases to the tsc output (apps/web/src after monorepo restructure)
        if (source.startsWith('@/')) {
          return resolveDts(path.resolve(tscOut, 'apps/web/src', source.slice(2)));
        }
        // Resolve @kilocode/db sub-path imports
        if (source === '@kilocode/db' || source.startsWith('@kilocode/db/')) {
          const subpath = source === '@kilocode/db' ? 'index' : source.replace('@kilocode/db/', '');
          return resolveDts(path.resolve(tscOut, 'packages/db/src', subpath));
        }
        return null;
      },
    },
    dts(),
  ],
};
