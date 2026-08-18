import type { O11YBinding } from './o11y-binding.js';
import type { NotificationsBinding } from './notifications-binding.js';

export type Env = Omit<
  Cloudflare.Env,
  | 'O11Y'
  | 'NOTIFICATIONS'
  | 'DIRECT_INGEST_PERCENT'
  | 'DIRECT_INGEST_USER_IDS'
  | 'DIRECT_INGEST_MAX_BYTES'
  | 'SESSION_SHARE_TOKEN_MIN_IAT'
> & {
  O11Y: O11YBinding;
  NOTIFICATIONS: NotificationsBinding;
  DIRECT_INGEST_PERCENT: string;
  DIRECT_INGEST_USER_IDS: string;
  DIRECT_INGEST_MAX_BYTES: string;
  SESSION_SHARE_TOKEN_MIN_IAT: string;
};
