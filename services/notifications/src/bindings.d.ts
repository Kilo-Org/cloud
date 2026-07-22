import type {} from './worker-configuration.d.ts';

// Augment the wrangler-generated Env with RPC method signatures for service
// bindings. `worker-configuration.d.ts` types these as plain Fetcher; this
// file layers on the RPC shape so call sites don't need runtime casts.
declare global {
  interface Env {
    EVENT_SERVICE: Fetcher & {
      isUserInContext(userId: string, context: string): Promise<boolean>;
    };
    // Local dev / E2E push sink mode. Absent from `wrangler.jsonc` (which
    // is single-config production); supplied via `.dev.vars` by
    // `pnpm dev:env`. The runtime check is string equality on `'log'`.
    PUSH_SINK_MODE?: string;
  }
}

export type NotificationsEnv = Env;
