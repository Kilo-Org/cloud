import { lookup as lookupCallback } from 'dns';
import type { LookupAddress, LookupOptions } from 'dns';
import { lookup } from 'dns/promises';
import { isIpAddress, isPublicIp } from '@kilocode/mcp-gateway';
import { isIP } from 'net';
import { Agent } from 'undici';

/** Maximum redirect hops followed before the request is rejected. */
const MAX_REDIRECT_HOPS = 3;
/** Maximum response body size, 10 MiB. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;
/** Maximum time for a single upstream hop. */
const UPSTREAM_TIMEOUT_MS = 10_000;
/** Maximum time for the whole proxied request, across every hop and the body. */
const REQUEST_DEADLINE_MS = 30_000;
/** How long a client may reuse a proxied image before revalidating. */
const CACHE_CONTROL = 'private, max-age=300';

/** Redirect statuses that carry a `Location` this proxy follows. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Image content types this proxy will forward. Anything else is rejected. */
const ALLOWED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

/** Bytes needed to recognise every allowed content type. */
const MAGIC_BYTES_NEEDED = 12;

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
 * Rejects any address that `isPublicIp` does not classify as public. This
 * excludes loopback, private, link-local, unique-local IPv6, unspecified,
 * multicast, reserved/test ranges, and broadcast addresses.
 */
function assertPublicAddress(address: string): void {
  const normalized = stripIpv6Brackets(address.toLowerCase());
  if (normalized.includes('%')) {
    throw new MediaProxyError('Media URL host must not include a zone id.');
  }
  if (!isIpAddress(normalized)) {
    throw new MediaProxyError('Media URL host resolves to an invalid address.');
  }
  if (!isPublicIp(normalized)) {
    throw new MediaProxyError('Media URL host resolves to a non-public address.');
  }
}

/**
 * Resolves a hostname and rejects the connection unless every answer is a
 * public address. This runs inside connection establishment, so the addresses
 * checked here are the addresses actually connected to: a DNS answer that
 * flips between a preflight check and the connect (DNS rebinding) cannot
 * reach a private destination.
 *
 * Exported for tests; production code reaches it through `guardedAgent`.
 */
export function guardedLookup(
  hostname: string,
  options: LookupOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number
  ) => void
): void {
  lookupCallback(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, '');
      return;
    }
    try {
      for (const entry of addresses) {
        assertPublicAddress(entry.address);
      }
    } catch (guardError) {
      callback(guardError as NodeJS.ErrnoException, '');
      return;
    }
    const first = addresses[0];
    if (!first) {
      callback(new MediaProxyError('Media URL host could not be resolved.'), '');
      return;
    }
    if (options.all === true) {
      callback(null, addresses);
      return;
    }
    callback(null, first.address, first.family);
  });
}

/**
 * Dispatcher used for every upstream hop. Its connect-time lookup is the
 * authoritative SSRF check; `assertSafeMediaUrl` only rejects obviously unsafe
 * URLs early and with a readable message.
 */
const guardedAgent = new Agent({ connect: { lookup: guardedLookup } });

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
 *
 * This resolution is a preflight, not the connection: `guardedAgent` repeats
 * the address check while the socket is opened.
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

function startsWith(bytes: Uint8Array, offset: number, ascii: string): boolean {
  for (let index = 0; index < ascii.length; index++) {
    if (bytes[offset + index] !== ascii.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

/**
 * Confirms the first bytes of the body match the content type the origin
 * declared, so a host cannot serve arbitrary bytes from our own origin behind
 * an `image/png` label.
 */
function matchesDeclaredType(contentType: string, bytes: Uint8Array): boolean {
  switch (contentType) {
    case 'image/png':
      return startsWith(bytes, 0, '\x89PNG\r\n\x1a\n');
    case 'image/jpeg':
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/gif':
      return startsWith(bytes, 0, 'GIF87a') || startsWith(bytes, 0, 'GIF89a');
    case 'image/webp':
      return startsWith(bytes, 0, 'RIFF') && startsWith(bytes, 8, 'WEBP');
    case 'image/avif':
      return startsWith(bytes, 4, 'ftyp');
    default:
      return false;
  }
}

/** Reads at least `MAGIC_BYTES_NEEDED` bytes, or everything if the body is shorter. */
async function readPrefix(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<{ chunks: Uint8Array[]; bytes: number; ended: boolean }> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return { chunks, bytes, ended: true };
    }
    chunks.push(value);
    bytes += value.byteLength;
    if (bytes >= MAGIC_BYTES_NEEDED) {
      return { chunks, bytes, ended: false };
    }
  }
}

function flatten(chunks: Uint8Array[], bytes: number): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

/**
 * Streams the already-read prefix and then the rest of the upstream body,
 * erroring the stream as soon as the total passes `MAX_BODY_BYTES`. The body
 * is never buffered in full, so memory stays flat regardless of the upstream
 * size, at the cost of signalling an oversized body mid-response rather than
 * as a status code.
 */
function cappedStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  prefix: Uint8Array[],
  prefixBytes: number,
  ended: boolean
): ReadableStream<Uint8Array> {
  let total = prefixBytes;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of prefix) {
        controller.enqueue(chunk);
      }
      if (ended) {
        controller.close();
      }
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        controller.error(new MediaProxyError('Media body exceeds the size limit.'));
        return;
      }
      controller.enqueue(value);
    },
    async cancel() {
      await reader.cancel().catch(() => {});
    },
  });
}

/**
 * Unwraps the `MediaProxyError` the guarded connect lookup rejects with, which
 * `fetch` reports as a `TypeError` with the guard error as its cause.
 */
function unwrapFetchError(error: unknown): unknown {
  if (error instanceof MediaProxyError) {
    return error;
  }
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause instanceof MediaProxyError ? cause : error;
}

/**
 * Fetches a media URL through the proxy safety chain: validates the URL and
 * every redirect hop, re-checks the resolved address while the socket opens,
 * follows at most three hops, requires an allowlisted image content type whose
 * magic bytes match, holds the whole request to a 30 second deadline, streams
 * the body and stops at 10 MiB, and forwards only a sanitized response (no
 * upstream header is copied, never the upstream redirect status).
 */
export async function fetchSafeMedia(urlString: string): Promise<Response> {
  let url = await assertSafeMediaUrl(urlString);
  const deadline = AbortSignal.timeout(REQUEST_DEADLINE_MS);

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.any([deadline, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
        dispatcher: guardedAgent,
      } as RequestInit);
    } catch (error) {
      throw unwrapFetchError(error);
    }

    if (REDIRECT_STATUSES.has(response.status)) {
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

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      throw new MediaProxyError('Media body exceeds the size limit.');
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new MediaProxyError('Media body is empty.');
    }

    const prefix = await readPrefix(reader);
    if (prefix.bytes === 0) {
      throw new MediaProxyError('Media body is empty.');
    }
    if (prefix.bytes > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new MediaProxyError('Media body exceeds the size limit.');
    }
    if (!matchesDeclaredType(contentType, flatten(prefix.chunks, prefix.bytes))) {
      await reader.cancel().catch(() => {});
      throw new MediaProxyError('Media does not match its declared image type.');
    }

    const headers = new Headers();
    headers.set('content-type', contentType);
    headers.set('cache-control', CACHE_CONTROL);
    headers.set('x-content-type-options', 'nosniff');
    return new Response(cappedStream(reader, prefix.chunks, prefix.bytes, prefix.ended), {
      status: 200,
      headers,
    });
  }

  // Unreachable: the `hop === MAX_REDIRECT_HOPS` branch above ends the loop.
  // Kept so the function has a return or throw on every path for the compiler.
  throw new MediaProxyError('Too many redirects.');
}
