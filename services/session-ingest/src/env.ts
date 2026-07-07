import type { NotificationsBinding } from './notifications-binding.js';
import type { O11YBinding } from './o11y-binding.js';

export type Env = Omit<Cloudflare.Env, 'O11Y' | 'NOTIFICATIONS'> & {
  O11Y: O11YBinding;
  NOTIFICATIONS: NotificationsBinding;
};
