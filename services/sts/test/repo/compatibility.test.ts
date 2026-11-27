import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { unstable_readConfig } from 'wrangler';

const compatibility = (path: string, env?: string) => {
  const config = unstable_readConfig({
    config: fileURLToPath(new URL(`../../${path}`, import.meta.url).href),
    env,
  });
  return { date: config.compatibility_date, flags: config.compatibility_flags };
};

// The workerd pool runs wrangler.test.jsonc, and test/worker/compatibility.test.ts proves there
// that a caught JOSE rejection is not reported as unhandled (panva/jose#892). Every environment
// that verifies with JOSE resolves the same compatibility settings, so it gets the same behaviour.
it.each([
  ['wrangler.jsonc', undefined],
  ['wrangler.jsonc', 'staging'],
  ['wrangler.jsonc', 'local'],
  ['test/fixtures/e2e/wrangler.sts.jsonc', undefined],
  ['test/fixtures/runtime/wrangler.jsonc', undefined],
])('%s (env %s) resolves the workerd pool compatibility settings', (path, env) => {
  expect(compatibility(path, env)).toEqual(compatibility('wrangler.test.jsonc'));
});
