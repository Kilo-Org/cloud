/** The origin of a private provider base URL; null when it is not a URL. */
export function getPrivateProviderOrigin(baseUrl: string): string | null {
  try {
    const { origin } = new URL(baseUrl.trim());
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/**
 * Whether sending credentials stored for `storedBaseUrl` to `baseUrl` would reach another host.
 * An unparseable URL counts as another host.
 */
export function privateProviderOriginChanged(storedBaseUrl: string, baseUrl: string): boolean {
  const stored = getPrivateProviderOrigin(storedBaseUrl);
  return stored === null || stored !== getPrivateProviderOrigin(baseUrl);
}
