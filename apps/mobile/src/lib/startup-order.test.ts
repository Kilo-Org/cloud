// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Text-contract guard over the root layout source. The module-scope bootstrap
// kicks (Sentry init, notification wiring, prefetch, theme preload) must stay
// in _layout.tsx, and the deferred connections/analytics must stay out of it.
const layoutPath = fileURLToPath(new URL('../app/_layout.tsx', import.meta.url));
const layoutSource = readFileSync(layoutPath, 'utf8');

const FORBIDDEN_IDENTIFIERS = [
  'createUserWebConnection',
  'EventServiceClient',
  'useIAP',
  'initPostHog',
  'initAppsFlyer',
  'new WebSocket',
] as const;

// Removes `//` line comments and `/* */` block comments while preserving line
// breaks, so a comment mentioning the call cannot satisfy the module-scope
// assertion.
function stripComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, match => match.replaceAll(/[^\n]/g, ''))
    .replaceAll(/\/\/[^\n]*/g, '');
}

describe('root layout startup order (text contract)', () => {
  it('calls initSentry(false) at module scope', () => {
    const codeSource = stripComments(layoutSource);
    const hasModuleScopeCall = codeSource
      .split('\n')
      .some(line => /^initSentry\(false\);$/.test(line));
    expect(
      hasModuleScopeCall,
      '_layout.tsx must call initSentry(false); at module scope (column 0)'
    ).toBe(true);
  });

  it.each(FORBIDDEN_IDENTIFIERS)('does not reference %s', identifier => {
    expect(layoutSource.includes(identifier), `_layout.tsx must not contain "${identifier}"`).toBe(
      false
    );
  });
});
