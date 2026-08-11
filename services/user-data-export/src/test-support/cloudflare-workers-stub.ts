/**
 * Stub for the `cloudflare:workers` module used by the node-environment unit tests,
 * wired up through `resolve.alias` in `vitest.config.ts`.
 *
 * `src/observability.ts` imports `tracing` from `cloudflare:workers`, which only the
 * Workers runtime can resolve; under plain vitest the import fails with "Cannot find
 * package 'cloudflare:workers'" and takes every test that reaches `worker.ts` with it.
 *
 * `enterSpan` here mirrors the part of the real contract our code depends on: it always
 * invokes the callback and returns its value, and hands over a span whose `setAttribute`
 * is a no-op. That matches the runtime for an unsampled request, which is also what the
 * `test/` workers-pool suite observes (`isTraced === false`), so instrumented code paths
 * behave the same in both suites.
 */
const inertSpan = {
  isTraced: false,
  setAttribute: () => undefined,
};

export const tracing = {
  enterSpan: <T, A extends unknown[]>(
    _name: string,
    callback: (span: typeof inertSpan, ...args: A) => T,
    ...args: A
  ): T => callback(inertSpan, ...args),
};
