// Minimal stub for the `cloudflare:workers` module so node-environment vitest
// can import worker code that defines Durable Objects and WorkerEntrypoint
// classes (the OAuth provider imports `WorkerEntrypoint` at module load).
// vitest.config.ts aliases `cloudflare:workers` here; the real module only
// exists under workerd.
export class DurableObject<TEnv = unknown> {
  protected ctx: DurableObjectState;
  protected env: TEnv;

  constructor(ctx: DurableObjectState, env: TEnv) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkerEntrypoint<TEnv = unknown> {
  protected ctx: ExecutionContext;
  protected env: TEnv;

  constructor(ctx: ExecutionContext, env: TEnv) {
    this.ctx = ctx;
    this.env = env;
  }
}
