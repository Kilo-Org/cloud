export function getSecretValue(secret: SecretsStoreSecret | string): Promise<string> {
  return typeof secret === 'string' ? Promise.resolve(secret) : secret.get();
}
