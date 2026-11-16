/**
 * The endpoint rule shared by the internal service clients.
 *
 * An endpoint is used only when its value is an absolute `https` URL, or an `http` URL on a
 * loopback hostname. Every other value counts as unconfigured, and no caller sends to it.
 */
const LOOPBACK_HOSTNAMES: Record<string, true> = {
  localhost: true,
  '127.0.0.1': true,
  '[::1]': true,
};

export function parseInternalServiceUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return url;
    return url.protocol === 'http:' && LOOPBACK_HOSTNAMES[url.hostname] === true ? url : null;
  } catch {
    return null;
  }
}
