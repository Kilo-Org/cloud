import dts from 'rollup-plugin-dts';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tscOut = path.resolve(__dirname, 'dist/tsc');

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
      resolveId(source, importer) {
        // Resolve @/* path aliases to the tsc output
        if (source.startsWith('@/')) {
          const resolved = path.resolve(tscOut, 'src', source.slice(2));
          return resolved + '.d.ts';
        }
        // Resolve @kilocode/db sub-path imports
        if (source === '@kilocode/db' || source.startsWith('@kilocode/db/')) {
          const subpath = source === '@kilocode/db' ? 'index' : source.replace('@kilocode/db/', '');
          return path.resolve(tscOut, 'packages/db/src', subpath) + '.d.ts';
        }
        // Resolve @kilocode/encryption
        if (source === '@kilocode/encryption') {
          return path.resolve(tscOut, 'packages/encryption/src/index') + '.d.ts';
        }
        return null;
      },
    },
    dts(),
  ],
};
