/** Milliseconds since the epoch; injectable so tests drive the cache without sleeping. */
export type SecretsClock = () => number;

/**
 * The part of a Worker `ExecutionContext` the client uses. A background revalidation is
 * passed to `waitUntil` so the runtime keeps the isolate alive until it settles.
 */
export type SecretsExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

export type SecretsSnapshot = {
  /** True when STS reported its copy stale, or when this client is past the fresh window. */
  stale: boolean;
  /** The time STS built the bundle, ISO-8601. */
  fetchedAt: string;
  etag: string;
};

export type Secrets = {
  /** Resolves one secret value; throws `SecretUnavailableError` when the bundle cannot serve it. */
  get(name: string, ctx?: SecretsExecutionContext): Promise<string>;
  /** Metadata for the bundle currently held in memory. */
  snapshot(ctx?: SecretsExecutionContext): Promise<SecretsSnapshot>;
};
