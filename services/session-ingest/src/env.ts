import type { O11YBinding } from './o11y-binding.js';
import type { NotificationsBinding } from './notifications-binding.js';

export type Env = Omit<
  Cloudflare.Env,
  | 'O11Y'
  | 'NOTIFICATIONS'
  | 'DIRECT_INGEST_PERCENT'
  | 'DIRECT_INGEST_MAX_BYTES'
  | 'SESSION_SHARE_TOKEN_MIN_IAT'
> & {
  O11Y: O11YBinding;
  NOTIFICATIONS: NotificationsBinding;
  DIRECT_INGEST_PERCENT: string;
  DIRECT_INGEST_MAX_BYTES: string;
  SESSION_SHARE_TOKEN_MIN_IAT: string;
  /**
   * Which credentials `POST /internal/session-access/invalidate` accepts
   * (`session-access-invalidate-auth.ts`): unset or `legacy-only` (`X-Internal-Secret`),
   * `legacy-and-sts`, `sts-only` or `disabled`.
   */
  SESSION_ACCESS_INVALIDATE_CREDENTIAL_ACCEPT?: string;
  /** The STS environment whose tokens that route accepts; read only in an STS mode. */
  STS_ENVIRONMENT?: string;
};
