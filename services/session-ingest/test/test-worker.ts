import { InternalUserEventsEntrypoint } from '../src/internal-user-events-entrypoint';

export { SessionIngestDO } from '../src/dos/SessionIngestDO';
export { UserConnectionDO } from '../src/dos/UserConnectionDO';

export class SessionIngestRPC extends InternalUserEventsEntrypoint {}

export default {
  fetch(): Response {
    return new Response('Session Ingest test worker');
  },
};
