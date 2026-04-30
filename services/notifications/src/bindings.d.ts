import type {} from './worker-configuration.d.ts';

// Augment the wrangler-generated Env with RPC method signatures for service
// bindings. `worker-configuration.d.ts` types these as plain Fetcher; this
// file layers on the RPC shape so call sites don't need runtime casts.
declare global {
  interface Env {
    EVENT_SERVICE: Fetcher & {
      isUserInContext(userId: string, context: string): Promise<boolean>;
    };
  }
}

export type NotificationsEnv = Env;
