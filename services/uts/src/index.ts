export { UtsKeySetDO } from './dos/UtsKeySetDO';
export { UtsSignerDO } from './dos/UtsSignerDO';
export { SignerKeys } from './signer-keys';
export { TicketRedeemer } from './tickets/redeemer';

import type { Env } from './env';
import { handleRequest } from './http';

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
