// The DO and metadata tests import `../../notifications/src`, whose modules read
// their bindings off a global `Env`. This package has no global `Env` (its
// `wrangler types` output names the interface `CloudflareBindings`), and
// notifications' own output cannot be included here because it embeds a whole
// workerd runtime that collides with `@cloudflare/workers-types`. So declare the
// global `Env` those modules expect: this package's bindings plus the
// notifications-only ones they touch.
import type { NotificationChannelDO } from '../../notifications/src/index';

declare global {
  interface Env extends CloudflareBindings {
    WORKER_ENV: string;
    KILO_WEB_API_BASE_URL: string;
    NEXTAUTH_SECRET: SecretsStoreSecret;
    INTERNAL_API_SECRET: SecretsStoreSecret;
    EXPO_ACCESS_TOKEN: SecretsStoreSecret;
    RECEIPTS_QUEUE: Queue;
    NOTIFICATION_CHANNEL_DO: DurableObjectNamespace<NotificationChannelDO>;
    EVENT_SERVICE: Fetcher & {
      isUserInContext(userId: string, context: string): Promise<boolean>;
    };
    PUSH_SINK_MODE?: string;
    APNS_TEAM_ID?: string;
    APNS_KEY_ID?: string;
    APNS_TOPIC?: string;
    APNS_PRIVATE_KEY?: SecretsStoreSecret;
  }
}
