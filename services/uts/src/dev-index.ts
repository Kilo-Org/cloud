/**
 * The mint Worker's entry for `wrangler dev -c wrangler.dev.jsonc` only: the deployed entry plus
 * the development signing route (`src/dev.ts`).
 */
export { UtsKeySetDO } from './dos/UtsKeySetDO';
export { UtsSignerDO } from './dos/UtsSignerDO';
export { SignerKeys } from './signer-keys';

import { handleDevRequest } from './dev';
import type { Env } from './env';

export default {
  fetch: handleDevRequest,
} satisfies ExportedHandler<Env>;
