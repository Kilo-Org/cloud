/**
 * The part of a Worker `ExecutionContext` (or of `@vercel/functions`) the client uses. A renewal or
 * an unanswered call is passed to `waitUntil` so the runtime keeps the instance alive until it
 * settles. Without it, a read that starts a renewal waits for it before it returns: a renewal
 * runs in the background only with a lifetime extension. Hot-path callers must pass `waitUntil`:
 * without it the read that starts a renewal can wait up to about 15 s over the Worker transport
 * and about 35 s over HTTP.
 */
export type ServiceTokensExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

/** One token: one audience and exactly one scope of that audience (design 5.3). */
export type ServiceTokenRequest = { audience: string; scope: string };

export type ServiceTokens = {
  /**
   * Resolves the token for one audience and scope, from memory when it holds a fresh one; throws
   * `ServiceTokenError` when it cannot. Create one client per isolate or process, at module scope.
   */
  get(request: ServiceTokenRequest, ctx?: ServiceTokensExecutionContext): Promise<string>;
};
