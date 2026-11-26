/**
 * The part of a Worker `ExecutionContext` (or of `@vercel/functions`) the client uses. A renewal or
 * an unanswered call is passed to `waitUntil` so the runtime keeps the instance alive until it
 * settles.
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
