import type { AuthEnv } from './auth';
import type { SessionSyncDO } from './dos/SessionSyncDO';
import type { SessionSyncTenantDO } from './dos/SessionSyncTenantDO';

export type Env = AuthEnv & {
  SESSION_SYNC_DO: DurableObjectNamespace<SessionSyncDO>;
  SESSION_SYNC_TENANT_DO: DurableObjectNamespace<SessionSyncTenantDO>;
  USER_REQUEST_LIMITER: RateLimit;
  USER_DATA_BLOCK_LIMITER: RateLimit;
  USER_BLOB_LIMITER: RateLimit;
  USER_TENANT_SESSIONS?: string;
  USER_TENANT_BYTES?: string;
  ORGANIZATION_TENANT_SESSIONS?: string;
  ORGANIZATION_TENANT_BYTES?: string;
  SESSION_SYNC_METRICS?: AnalyticsEngineDataset;
  /** Private bucket for session blobs. Objects are never public. */
  SESSION_SYNC_R2: R2Bucket;
};
