export { UtsSignerDO } from './dos/UtsSignerDO';
export { SignerKeys } from './signer-keys';

import type { Env } from './env';
import { handleRequest } from './http';

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
