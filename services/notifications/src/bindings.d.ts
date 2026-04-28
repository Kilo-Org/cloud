// Augment the wrangler-generated Env with RPC method signatures for service
// bindings. `worker-configuration.d.ts` types EVENT_SERVICE as plain Fetcher;
// this file layers on the RPC shape so call sites get type-safe method calls.
declare global {
  interface Env {
    EVENT_SERVICE: Fetcher & {
      isUserInContext(userId: string, context: string): Promise<boolean>;
    };
  }
}

export {};
