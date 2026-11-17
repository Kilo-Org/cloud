/** The origin of an endpoint base URL; null when it is not a URL. */
export function getEndpointOrigin(baseUrl: string): string | null {
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
export function endpointOriginChanged(storedBaseUrl: string, baseUrl: string): boolean {
  const stored = getEndpointOrigin(storedBaseUrl);
  return stored === null || stored !== getEndpointOrigin(baseUrl);
}
