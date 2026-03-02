/**
 * Resolves a secret value from either a `SecretsStoreSecret` (production, has `.get()`)
 * or a plain string (test env vars set in wrangler.test.jsonc).
 */
export async function resolveSecret(binding: SecretsStoreSecret | string): Promise<string> {
  if (typeof binding === 'string') return binding;
  return binding.get();
}
