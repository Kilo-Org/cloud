import type { AuthEnv } from './auth';
import type { SessionSyncDO } from './dos/SessionSyncDO';

export type Env = AuthEnv & {
  SESSION_SYNC_DO: DurableObjectNamespace<SessionSyncDO>;
  /** Private bucket for session blobs. Objects are never public. */
  SESSION_SYNC_R2: R2Bucket;
};
