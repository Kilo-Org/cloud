export { UtsAuditRelayDO } from './dos/UtsAuditRelayDO';
export { UtsKeySetDO } from './dos/UtsKeySetDO';
export { UtsSignerDO } from './dos/UtsSignerDO';
export { FeedReads } from './feed/reads';
export { UtsFeedDO } from './feed/UtsFeedDO';
export { PatLookup } from './pat/entrypoint';
export { SignerKeys } from './signer-keys';
export { TicketRedeemer } from './tickets/redeemer';

import type { Env } from './env';
import { scheduled } from './scheduled';
import { handleRequest } from './http';

export default {
  fetch: handleRequest,
  scheduled,
} satisfies ExportedHandler<Env>;
