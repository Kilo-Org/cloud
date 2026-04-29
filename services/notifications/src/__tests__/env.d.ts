import type NotificationsService from '../index';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    SELF: Service<NotificationsService>;
  }
}
