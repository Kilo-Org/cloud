export { UtsKeySetDO } from './dos/UtsKeySetDO';
export { UtsSignerDO } from './dos/UtsSignerDO';
export { FeedReads } from './feed/reads';
export { UtsFeedDO } from './feed/UtsFeedDO';
export { SignerKeys } from './signer-keys';

import type { Env } from './env';
import { handleRequest } from './http';

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
