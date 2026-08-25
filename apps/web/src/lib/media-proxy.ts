import { lookup } from 'dns/promises';
import ipaddr from 'ipaddr.js';
import { isIP } from 'net';

/** Maximum redirect hops followed before the request is rejected. */
const MAX_REDIRECT_HOPS = 3;
/** Maximum response body size, 10 MiB. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Image content types this proxy will forward. Anything else is rejected. */
const ALLOWED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

export class MediaProxyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaProxyError';
  }
}

function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

/**
 * Rejects any address that ipaddr.js does not classify as a public unicast
 * destination. This excludes loopback, private, link-local, unique-local IPv6,
 * unspecified, multicast, reserved/test ranges, and broadcast addresses.
 */
function assertPublicAddress(address: string): void {
  const normalized = stripIpv6Brackets(address.toLowerCase());
  if (normalized.includes('%')) {
    throw new MediaProxyError('Media URL host must not include a zone id.');
  }
  if (!ipaddr.isValid(normalized)) {
    throw new MediaProxyError('Media URL host resolves to an invalid address.');
  }
  if (ipaddr.process(normalized).range() !== 'unicast') {
    throw new MediaProxyError('Media URL host resolves to a non-public address.');
  }
}

async function assertHostnamePublic(hostname: string): Promise<void> {
  const bare = stripIpv6Brackets(hostname.toLowerCase());
  if (bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.local')) {
    throw new MediaProxyError('Media URL host is not publicly reachable.');
  }

  if (isIP(bare) !== 0) {
    assertPublicAddress(bare);
    return;
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(bare, { all: true, verbatim: true });
  } catch {
    throw new MediaProxyError('Media URL host could not be resolved.');
  }

  if (addresses.length === 0) {
    throw new MediaProxyError('Media URL host could not be resolved.');
  }

  for (const { address } of addresses) {
    assertPublicAddress(address);
  }
}

/**
 * Validates that the given string is a media URL safe to fetch: an HTTPS URL
 * with no credentials whose hostname resolves only to public addresses.
 * Resolves and returns the parsed URL, or throws a `MediaProxyError`.
 */
export async function assertSafeMediaUrl(urlString: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new MediaProxyError('Invalid media URL.');
  }

  if (url.protocol !== 'https:') {
    throw new MediaProxyError('Media URL must use https.');
  }

  if (url.username || url.password) {
    throw new MediaProxyError('Media URL must not include credentials.');
  }

  await assertHostnamePublic(url.hostname);
  return url;
}

function baseContentType(header: string | null): string {
  return header ? (header.split(';')[0]?.trim().toLowerCase() ?? '') : '';
}

/**
 * Reads the response body through its stream reader and stops the moment the
 * accumulated bytes exceed `maxBytes`, cancelling the stream so an oversized
 * upstream body is never buffered in full.
 */
async function readCappedBody(response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) {
    return new Uint8Array(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      if (total + value.byteLength > maxBytes) {
        throw new MediaProxyError('Media body exceeds the size limit.');
      }
      total += value.byteLength;
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed or errored; a failed cancel is not
      // relevant to the caller.
    }
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Fetches a media URL through the proxy safety chain: validates the URL and
 * every redirect hop, follows at most three hops, requires an allowlisted
 * image content type, caps the body at 10 MiB, and forwards only a sanitized
 * response (no `Set-Cookie`, `Set-Cookie2`, or `WWW-Authenticate`, never the
 * upstream redirect status).
 */
export async function fetchSafeMedia(urlString: string): Promise<Response> {
  let url = await assertSafeMediaUrl(urlString);

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const response = await fetch(url, { redirect: 'manual' });

    if (response.status >= 300 && response.status < 400) {
      if (hop === MAX_REDIRECT_HOPS) {
        throw new MediaProxyError('Too many redirects.');
      }
      const location = response.headers.get('location');
      if (!location) {
        throw new MediaProxyError('Redirect is missing a Location header.');
      }
      url = await assertSafeMediaUrl(new URL(location, url).toString());
      continue;
    }

    if (!response.ok) {
      throw new MediaProxyError(`Upstream returned ${response.status}.`);
    }

    const contentType = baseContentType(response.headers.get('content-type'));
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      throw new MediaProxyError('Media is not an allowed image type.');
    }

    const body = await readCappedBody(response, MAX_BODY_BYTES);

    const headers = new Headers();
    headers.set('content-type', contentType);
    headers.set('cache-control', 'private');
    return new Response(body, { status: 200, headers });
  }

  throw new MediaProxyError('Too many redirects.');
}
