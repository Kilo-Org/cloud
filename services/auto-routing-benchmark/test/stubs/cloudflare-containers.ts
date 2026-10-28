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

  constructor(_ctx: unknown, env: Env) {
    this.env = env;
  }

  async fetch(_request: Request): Promise<Response> {
    return new Response(null, { status: 501 });
  }

  async destroy(): Promise<void> {}
}
