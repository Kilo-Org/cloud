/**
 * Resolves a secret value from either a `SecretsStoreSecret` (production, has `.get()`)
 * or a plain string (test env vars set in wrangler.test.jsonc).
 *
 * Returns `null` when the Secrets Store fetch fails (transient network error,
 * misconfigured store, etc.) so callers can return a clean 500 instead of
 * letting an opaque "Secrets Worker: Failed to fetch secret" bubble up.
 */
export declare function resolveSecret(binding: SecretsStoreSecret | string): Promise<string | null>;
