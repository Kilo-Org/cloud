/**
 * The mint Worker's entry for `wrangler dev --env local` only: the deployed entry plus the
 * development signing route and the development sign-in hand-off (`src/dev.ts`).
 */
export { UtsReplayDO } from './dos/UtsReplayDO';
export { UtsSignerDO } from './dos/UtsSignerDO';

import { handleDevRequest } from './dev';
import type { Env } from './env';

export default {
  fetch: handleDevRequest,
} satisfies ExportedHandler<Env>;
