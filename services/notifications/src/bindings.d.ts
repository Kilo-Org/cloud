import type { BundleBinding } from '@kilocode/secrets-client';
import type {} from './worker-configuration.d.ts';

// Augment the wrangler-generated Env with RPC method signatures for service
// bindings. `worker-configuration.d.ts` types these as plain Fetcher; this
// file layers on the RPC shape so call sites don't need runtime casts.
declare global {
  interface Env {
    EVENT_SERVICE: Fetcher & {
      isUserInContext(userId: string, context: string): Promise<boolean>;
    };
    // `wrangler types` types the cross-Worker entrypoint binding as a plain
    // `Service`; this layers on the `SecretsBroker` RPC shape.
    STS: Service & BundleBinding;
    // Local dev / E2E push sink mode. Absent from `wrangler.jsonc` (which
    // is single-config production); supplied via `.dev.vars` by
    // `pnpm dev:env`. The runtime check is string equality on `'log'`.
    PUSH_SINK_MODE?: string;
    // Staging push switch (`lib/push-gate.ts`). Read only when
    // `WORKER_ENV` is `staging`; only the exact string `'true'` lets that
    // deployment reach Expo or APNs.
    NOTIFICATIONS_PUSH_ENABLED?: string;
    // Base origin of the web app, used to reach the internal
    // glanceable-agents-snapshot route (see ENVIRONMENT.md). Optional so a
    // missing value degrades to "skip aggregate delivery".
    KILO_WEB_API_BASE_URL?: string;
    // APNs token-based credentials for Live Activity delivery. Optional so a
    // missing credential degrades to "skip the iOS send" with a warning. See
    // ENVIRONMENT.md for the meaning of each name; never log the private key
    // or a device token.
    APNS_TEAM_ID?: string;
    APNS_KEY_ID?: string;
    APNS_PRIVATE_KEY?: SecretsStoreSecret;
    APNS_TOPIC?: string;
  }
}

export type NotificationsEnv = Env;
