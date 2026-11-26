/**
 * The mint Worker's entry for `wrangler dev --env local` only: the deployed entry plus the
 * development signing route, the development sign-in hand-off and a feed object that the local
 * end-to-end run can stop (`src/dev.ts`, `src/dev-feed.ts`).
 */
export { DevUtsFeedDO as UtsFeedDO } from './dev-feed';
export { UtsKeySetDO } from './dos/UtsKeySetDO';
export { UtsSignerDO } from './dos/UtsSignerDO';
export { FeedReads } from './feed/reads';
export { SignerKeys } from './signer-keys';

import { handleDevRequest } from './dev';
import type { Env } from './env';

export default {
  fetch: handleDevRequest,
} satisfies ExportedHandler<Env>;
