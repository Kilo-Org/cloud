import type { O11YBinding } from './o11y-binding.js';
import type { NotificationsBinding } from './notifications-binding.js';

export type Env = Omit<
  Cloudflare.Env,
  | 'O11Y'
  | 'NOTIFICATIONS'
  | 'DIRECT_INGEST_PERCENT'
  | 'DIRECT_INGEST_USER_IDS'
  | 'DIRECT_INGEST_MAX_BYTES'
  | 'REMOTE_SESSION_ATTENTION_PUSH_USER_ID'
> & {
  O11Y: O11YBinding;
  NOTIFICATIONS: NotificationsBinding;
  DIRECT_INGEST_PERCENT: string;
  DIRECT_INGEST_USER_IDS: string;
  DIRECT_INGEST_MAX_BYTES: string;
  /** User ID permitted to receive remote session attention pushes during the rollout. */
  REMOTE_SESSION_ATTENTION_PUSH_USER_ID?: string;
};
