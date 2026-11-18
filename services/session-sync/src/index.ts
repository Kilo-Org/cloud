import { app } from './app';
import { instrument } from './metrics';
import type { Env } from './env';

export { SessionSyncDO } from './dos/SessionSyncDO';
export { SessionSyncTenantDO } from './dos/SessionSyncTenantDO';
export { SessionRelayDO } from './dos/SessionRelayDO';
export { SessionPresenceDO } from './dos/SessionPresenceDO';
export { SessionNotificationsDO } from './dos/SessionNotificationsDO';

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    instrument(request, env, ctx, measured => app.fetch(measured, env, ctx)),
};
