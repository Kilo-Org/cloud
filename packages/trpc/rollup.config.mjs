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

// These packages are declaration-boundary imports in the generated router
// types. Leave them external instead of asking rollup-plugin-dts to inline
// implementation package declarations into @kilocode/trpc's single d.ts.
const external = [
  'pg',
  '@tanstack/react-query',
  '@trpc/client',
  'next/server',
  '@kilocode/encryption',
  '@kilocode/kiloclaw-instance-tiers',
  '@kilocode/worker-utils',
  '@kilocode/worker-utils/security-remediation-policy',
  '@kilocode/kilo-chat',
];

const plugins = [
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
];

const banner =
  '// Auto-generated — do not edit. Rebuild with: pnpm --filter @kilocode/trpc run build';

// Two separate single-artifact bundles. `mobile` composes only the namespaces
// the mobile app uses, so `dist/mobile.d.ts` is a smaller client-facing type
// surface than the full `dist/index.d.ts`. A shared bundle cannot shrink because
// MobileRouter ⊂ RootRouter, so each entry gets its own input → output.
function makeConfig(inputRel, outputFile) {
  return {
    external,
    input: `./dist/tsc/packages/trpc/src/${inputRel}`,
    output: { file: outputFile, format: 'es', banner },
    plugins,
  };
}

export default [
  makeConfig('index.d.ts', './dist/index.d.ts'),
  makeConfig('mobile.d.ts', './dist/mobile.d.ts'),
];
