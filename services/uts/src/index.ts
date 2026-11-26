export { UtsKeySetDO } from './dos/UtsKeySetDO';
export { UtsSignerDO } from './dos/UtsSignerDO';
export { PatLookup } from './pat/entrypoint';
export { SignerKeys } from './signer-keys';

import type { Env } from './env';
import { handleRequest } from './http';

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
