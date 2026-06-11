// Node-safe stub for `@cloudflare/containers`, aliased in vitest.config.ts.
//
// The real package imports `cloudflare:workers`, which only exists in the
// workerd runtime. Unit tests run in the node pool and merely need the worker
// entry (src/index.ts) to import without pulling in that chain — they never
// instantiate the container DO. This stub provides the minimal `Container`
// base class so `class BenchRunnerContainer extends Container<Env>` resolves.

export class Container<Env = unknown> {
  defaultPort?: number;
  sleepAfter?: string;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_ctx: unknown, _env: Env) {}
}
