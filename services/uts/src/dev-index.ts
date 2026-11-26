/**
 * The mint Worker's entry for `wrangler dev -c wrangler.dev.jsonc` only: the deployed entry plus
 * the development signing route, the development sign-in hand-off and a feed object that the local
 * end-to-end run can stop (`src/dev.ts`, `src/dev-feed.ts`). `test/repo` fails any other config
 * that runs it, and its build command refuses every Wrangler command but `dev`, so no deploy or
 * version upload bundles it.
 */
export { DevUtsFeedDO as UtsFeedDO } from './dev-feed';
export { UtsAuditRelayDO } from './dos/UtsAuditRelayDO';
export { UtsKeySetDO } from './dos/UtsKeySetDO';
export { UtsSignerDO } from './dos/UtsSignerDO';
export { FeedReads } from './feed/reads';
export { PatLookup } from './pat/entrypoint';
export { SignerKeys } from './signer-keys';

import { handleDevRequest } from './dev';
import type { Env } from './env';
import { scheduled } from './scheduled';

export default {
  fetch: handleDevRequest,
  scheduled,
} satisfies ExportedHandler<Env>;
