// Node-safe stub for `@cloudflare/containers`, aliased in vitest.config.ts.
//
// The real package imports `cloudflare:workers`, which only exists in the
// workerd runtime. Unit tests run in the node pool. This stub provides the
// minimal `Container` base class so `class BenchRunnerContainer extends
// Container<Env>` resolves, and a `fetch` that tests replace to observe the
// request the container class forwards.

export class Container<Env = unknown> {
  defaultPort?: number;
  sleepAfter?: string;
  protected readonly env: Env;
  // The class under test reads its durable cancellation tombstones from `this.ctx.storage`;
  // the runtime base class keeps the Durable Object context, so the stub must too.
  protected readonly ctx: unknown;

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(_request: Request): Promise<Response> {
    return new Response(null, { status: 501 });
  }

  // The class under test reads the container state to keep a cancel from starting an
  // instance that has no subprocess to stop; tests replace this to pick a state.
  async getState(): Promise<{ status: 'stopped'; lastChange: number }> {
    return { status: 'stopped', lastChange: Date.now() };
  }

  async destroy(): Promise<void> {}
}
