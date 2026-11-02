/**
 * Resolves a secret value from either a `SecretsStoreSecret` (production, has
 * `.get()`) or a plain string (test env vars set in wrangler.test.jsonc).
 *
 * Mirrors `services/gastown/src/util/secret.util.ts`.
 */
export async function resolveSecret(binding: SecretsStoreSecret | string): Promise<string> {
  return typeof binding === 'string' ? binding : binding.get();
}
