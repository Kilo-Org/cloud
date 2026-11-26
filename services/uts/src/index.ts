export { UtsAuditRelayDO } from './dos/UtsAuditRelayDO';
export { UtsKeySetDO } from './dos/UtsKeySetDO';
export { UtsSignerDO } from './dos/UtsSignerDO';
export { SignerKeys } from './signer-keys';

import type { Env } from './env';
import { scheduled } from './scheduled';
import { handleRequest } from './http';

export default {
  fetch: handleRequest,
  scheduled,
} satisfies ExportedHandler<Env>;
