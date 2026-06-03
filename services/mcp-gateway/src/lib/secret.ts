export async function resolveSecret(binding: SecretsStoreSecret | string): Promise<string | null> {
  if (typeof binding === 'string') return binding;
  try {
    return await binding.get();
  } catch {
    return null;
  }
}
