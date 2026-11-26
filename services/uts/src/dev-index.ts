/**
 * The mint Worker's entry for `wrangler dev --env local` only: the deployed entry plus the
 * development signing route and the development sign-in hand-off (`src/dev.ts`).
 */
export { UtsAuditRelayDO } from './dos/UtsAuditRelayDO';
export { UtsKeySetDO } from './dos/UtsKeySetDO';
export { UtsSignerDO } from './dos/UtsSignerDO';
export { SignerKeys } from './signer-keys';

import { handleDevRequest } from './dev';
import type { Env } from './env';
import { scheduled } from './scheduled';

export default {
  fetch: handleDevRequest,
  scheduled,
} satisfies ExportedHandler<Env>;
