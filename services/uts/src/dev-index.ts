/**
 * The mint Worker's entry for `wrangler dev -c wrangler.dev.jsonc` only: the deployed entry plus
 * the development signing route and the development sign-in hand-off (`src/dev.ts`). `test/repo`
 * fails any other config that runs it, and its build command refuses every Wrangler command but
 * `dev`, so no deploy or version upload bundles it.
 */
export { UtsKeySetDO } from './dos/UtsKeySetDO';
export { UtsSignerDO } from './dos/UtsSignerDO';
export { SignerKeys } from './signer-keys';

import { handleDevRequest } from './dev';
import type { Env } from './env';

export default {
  fetch: handleDevRequest,
} satisfies ExportedHandler<Env>;
