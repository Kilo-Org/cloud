/**
 * Post-process worker-configuration.d.ts after `wrangler types`.
 *
 * Wrangler cannot declare worker secrets or deploy-time `--var` values, so the
 * generated file omits the Sentry bindings. Add them back here instead of
 * hand-editing the generated output.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'worker-configuration.d.ts';
let src = readFileSync(FILE, 'utf8');

if (!src.includes('SENTRY_DSN')) {
  src = src.replace(
    'interface __BaseEnv_Env {',
    'interface __BaseEnv_Env {\n\tSENTRY_DSN?: string; // worker secret\n\tSENTRY_RELEASE?: string; // deploy-time --var'
  );
}

writeFileSync(FILE, src);
console.log('[patch-worker-types] patched', FILE);
