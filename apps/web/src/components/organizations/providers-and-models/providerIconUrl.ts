const OPENROUTER_ORIGIN = 'https://openrouter.ai';

/**
 * Catalog icon hosts, taken from the provider data the sync stores: OpenRouter
 * serves most icons as relative `/images/...` paths and the rest as Google
 * favicon URLs, and Kilo synthesizes placeholder icons for providers the
 * upstream lacks. A catalog icon URL is untrusted supply-chain input, so any
 * other host is dropped instead of being rendered.
 */
const PROVIDER_ICON_HOSTNAMES: Readonly<Record<string, true>> = {
  'openrouter.ai': true,
  't0.gstatic.com': true,
  'placehold.co': true,
};

/**
 * Resolves a catalog provider icon to an HTTPS URL on a known catalog host.
 * Returns `null` when the value cannot be trusted, so the caller renders no
 * icon rather than pointing the viewer's browser at an arbitrary origin.
 */
export function normalizeProviderIconUrl(rawUrl: string | null | undefined): string | null {
  const trimmed = rawUrl?.trim();
  if (!trimmed || trimmed.startsWith('//')) return null;

  let url: URL;
  try {
    url = new URL(trimmed, `${OPENROUTER_ORIGIN}/`);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (!Object.hasOwn(PROVIDER_ICON_HOSTNAMES, url.hostname)) return null;
  return url.toString();
}
