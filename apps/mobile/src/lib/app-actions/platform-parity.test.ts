// One implementation for both platforms on the shared app-action path.
//
// The contract, the dispatcher and the action runtime are shared JS: the same
// four actions must behave identically on iOS and Android, and each platform's
// native half only translates its entry point into this contract. So nothing on
// this path may branch on the platform, and stored preferences are read through
// the app's one cross-platform SecureStore entry point instead of a second,
// per-platform read. This suite reads the shared sources in node and holds them
// to that: a per-platform branch that would ship to one platform only fails
// here.

// eslint-disable-next-line import/no-nodejs-modules -- vitest-only parity check, runs in node, never bundled into the app
import { readdirSync, readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only parity check, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const DIRECTORY = fileURLToPath(new URL('./', import.meta.url));

/** Every shared (non-test) module of the action path, with its source text. */
function sharedSources(): { file: string; source: string }[] {
  return readdirSync(DIRECTORY)
    .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .toSorted()
    .map(name => ({ file: name, source: readFileSync(`${DIRECTORY}${name}`, 'utf8') }));
}

/**
 * A per-platform branch in shared JS: a `Platform.OS`/`Platform.select` check,
 * or an import of a platform-suffixed module.
 */
const PLATFORM_BRANCH =
  /\bPlatform\.(?:OS|select|Version)\b|from '[^']+\.(?:ios|android)'|require\('[^']+\.(?:ios|android)'\)/;

describe('one implementation for both platforms', () => {
  it('branches on the platform nowhere on the shared action path', () => {
    const sources = sharedSources();
    expect(sources.length).toBeGreaterThan(0);
    for (const { file, source } of sources) {
      expect(PLATFORM_BRANCH.test(source), `${file} carries a per-platform branch`).toBe(false);
    }
  });

  it('reads stored preferences through the one cross-platform SecureStore entry point', () => {
    const runtime = sharedSources().find(({ file }) => file === 'start-agent-runtime.ts');
    expect(runtime).toBeDefined();
    expect(runtime?.source).toContain(
      "import { readStoredValue } from '@/lib/auth/secure-store-value';"
    );
    expect(runtime?.source, 'no direct expo-secure-store import').not.toMatch(
      /^import .*from 'expo-secure-store';$/m
    );
  });
});
