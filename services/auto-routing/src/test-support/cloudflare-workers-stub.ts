// Minimal stub for the `cloudflare:workers` module so node-environment
// vitest can import worker code that defines Durable Objects.
export class DurableObject<TEnv = unknown> {
  protected ctx: DurableObjectState;
  protected env: TEnv;

  constructor(ctx: DurableObjectState, env: TEnv) {
    this.ctx = ctx;
    this.env = env;
  }
}
