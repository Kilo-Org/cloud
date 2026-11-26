import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, test } from '@jest/globals';

const REPOSITORY_ROOT = resolve(__dirname, '../../../../..');
const WEB_APP = join(REPOSITORY_ROOT, 'apps/web');
const WEB_SHARED_SRC = join(REPOSITORY_ROOT, 'packages/web-shared/src');
const AI_GATEWAY_SRC = join(REPOSITORY_ROOT, 'apps/ai-gateway/src');
const SIGNER_MODULE = join(WEB_APP, 'src/lib/auth/kilo-token-signing.ts');

/**
 * Runtime code that the ai-gateway bundle contains, with the directory its `@/`
 * resolves to. apps/web also bundles web-shared, where `@/` would resolve to
 * apps/web, so that is the root a web-shared `@/` import is checked against.
 */
const GUARDED_TREES = [
  { name: 'apps/ai-gateway', root: AI_GATEWAY_SRC, appSrc: AI_GATEWAY_SRC },
  { name: 'packages/web-shared', root: WEB_SHARED_SRC, appSrc: join(WEB_APP, 'src') },
];

const SOURCE_FILE = /\.(?:[cm]?js|tsx?)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** Specifiers of `import`/`export … from`, side-effect imports, `import()` and `require()`. */
const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;

function runtimeSourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap(entry => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return entry === 'tests' || entry === 'node_modules' ? [] : runtimeSourceFiles(path);
    }
    return SOURCE_FILE.test(entry) && !TEST_FILE.test(entry) ? [path] : [];
  });
}

function resolveSpecifier(specifier: string, file: string, appSrc: string): string | undefined {
  if (specifier.startsWith('.')) return resolve(dirname(file), specifier);
  if (specifier.startsWith('@/')) return join(appSrc, specifier.slice('@/'.length));
  if (specifier.startsWith('@kilocode/web-shared/')) {
    return join(WEB_SHARED_SRC, specifier.slice('@kilocode/web-shared/'.length));
  }
  return undefined;
}

/**
 * Imports that reach into apps/web. Any apps/web module may import the signer,
 * so refusing all of them also refuses a transitive path to it.
 */
function webAppImports(source: string, file: string, appSrc: string): string[] {
  return Array.from(source.matchAll(IMPORT_SPECIFIER), ([, specifier]) => specifier).filter(
    specifier => {
      const target = resolveSpecifier(specifier, file, appSrc);
      return target !== undefined && (target === WEB_APP || target.startsWith(WEB_APP + sep));
    }
  );
}

describe('Kilo token signer boundary', () => {
  test('the signer module lives in apps/web', () => {
    expect(existsSync(SIGNER_MODULE)).toBe(true);
  });

  test('detects static, type-only, side-effect, re-exported, dynamic and required imports', () => {
    const file = join(WEB_SHARED_SRC, 'lib/example.ts');
    const source = [
      "import { generateApiToken } from '@/lib/auth/kilo-token-signing';",
      "import type { TOKEN_EXPIRY } from '../../../../apps/web/src/lib/auth/kilo-token-signing';",
      "export * from '../../../../apps/web/src/lib/auth/kilo-token-signing';",
      "const signer = await import('@/lib/auth/kilo-token-signing');",
      "const required = require('../../../../apps/web/src/lib/user');",
      "import '@/lib/auth/kilo-token-signing';",
      'import {',
      '  generateOrganizationApiToken,',
      "} from '@/lib/auth/kilo-token-signing';",
      "import { validateAuthorizationHeader } from '@kilocode/web-shared/lib/tokens';",
      "import jwt from 'jsonwebtoken';",
    ].join('\n');

    expect(webAppImports(source, file, join(WEB_APP, 'src'))).toHaveLength(7);
  });

  test.each(GUARDED_TREES)('$name runtime code does not import apps/web', ({ root, appSrc }) => {
    const files = runtimeSourceFiles(root);
    expect(files.length).toBeGreaterThan(10);

    const offenders = files.flatMap(file =>
      webAppImports(readFileSync(file, 'utf8'), file, appSrc).map(
        specifier => `${relative(REPOSITORY_ROOT, file)}: ${specifier}`
      )
    );

    expect(offenders).toEqual([]);
  });
});
