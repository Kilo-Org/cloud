/**
 * Hostnames, in `URL.hostname` form, that name the sandbox itself when a server
 * inside it writes them in a link or a redirect. The web chat link parser and
 * the Worker's `Location` rewrite share this one list.
 */
const PREVIEW_LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]']);

export function isPreviewLoopbackHostname(hostname: string): boolean {
  return PREVIEW_LOOPBACK_HOSTNAMES.has(hostname);
}
