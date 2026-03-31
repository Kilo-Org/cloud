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
  external: ['pg'],
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
        // Resolve @/* path aliases to the tsc output
        if (source.startsWith('@/')) {
          return resolveDts(path.resolve(tscOut, 'src', source.slice(2)));
        }
        // Resolve @kilocode/db sub-path imports
        if (source === '@kilocode/db' || source.startsWith('@kilocode/db/')) {
          const subpath = source === '@kilocode/db' ? 'index' : source.replace('@kilocode/db/', '');
          return resolveDts(path.resolve(tscOut, 'packages/db/src', subpath));
        }
        // Resolve @kilocode/encryption
        if (source === '@kilocode/encryption') {
          return resolveDts(path.resolve(tscOut, 'packages/encryption/src/index'));
        }
        return null;
      },
    },
    dts(),
  ],
};
