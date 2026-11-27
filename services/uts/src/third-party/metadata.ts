import { z } from 'zod';

/**
 * Client ID Metadata Documents (design 5.9; MCP 2026-07-28 client registration,
 * draft-ietf-oauth-client-id-metadata-document). A third-party client's id is the HTTPS URL of a
 * JSON document that names the client and its redirect URIs. UTS fetches the document itself,
 * checks that it names the same URL, and caches it in the identity store per its HTTP cache
 * headers. Dynamic client registration stays off.
 *
 * The fetch is a request UTS makes to a URL anyone can choose, so it is guarded:
 * - the URL is HTTPS on the default port, with a path, without credentials, a query or a
 *   fragment, in its canonical form, and its host is a domain name: never an IP literal, a
 *   single label, `localhost` or a name of a private name space (`.local`, `.internal`,
 *   `.localhost`, `.home.arpa`). Workers cannot open connections into private networks, so a
 *   name that resolves to a private address does not reach one either;
 * - no redirect is followed: a 3xx answer refuses the client;
 * - the answer must be `200` (or `304` for a revalidation) with a JSON content type and at most
 *   8 KiB of body, read as a stream that stops at the limit, within 5 seconds in all;
 * - the cache time comes from `Cache-Control: max-age`, bounded to 5 minutes to 24 hours, 1 hour
 *   when the answer names none.
 */

/** The longest document body UTS reads. The identity store keeps at most 16 KiB of its JSON text. */
export const CLIENT_METADATA_MAX_BYTES = 8 * 1024;
/** The whole fetch, headers and body, ends by then. */
export const CLIENT_METADATA_TIMEOUT_MS = 5_000;
export const CLIENT_METADATA_MIN_CACHE_SECONDS = 5 * 60;
export const CLIENT_METADATA_MAX_CACHE_SECONDS = 24 * 60 * 60;
export const CLIENT_METADATA_DEFAULT_CACHE_SECONDS = 60 * 60;
const MAX_CLIENT_ID_LENGTH = 2048;
const MAX_ETAG_LENGTH = 256;

/** Host names of private name spaces, which never name a public client. */
const PRIVATE_NAME_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];
const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;
/** A DNS name of at least two labels, each 1 to 63 letters, digits or hyphens, no edge hyphen. */
const DOMAIN_NAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Why `clientId` cannot be a Client ID Metadata Document URL that UTS fetches, or null when it
 * can. The identity store's own check (`uts.third_party_clients.client_id`) is the shape
 * `https://<host>/<path>` with no query or fragment; this adds the guards above.
 */
export function clientIdUrlProblem(clientId: string): string | null {
  if (clientId.length > MAX_CLIENT_ID_LENGTH) return 'too long';
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return 'not a URL';
  }
  if (url.protocol !== 'https:') return 'not HTTPS';
  if (url.href !== clientId) return 'not in canonical form';
  if (url.username !== '' || url.password !== '') return 'carries credentials';
  if (url.port !== '') return 'names a port';
  if (url.search !== '' || url.hash !== '') return 'has a query or fragment';
  if (url.pathname === '/' || url.pathname === '') return 'has no path';
  const host = url.hostname;
  if (host.startsWith('[') || IPV4_LITERAL.test(host)) return 'names an IP address';
  if (!DOMAIN_NAME.test(host)) return 'does not name a domain';
  if (host === 'localhost' || PRIVATE_NAME_SUFFIXES.some(suffix => host.endsWith(suffix))) {
    return 'names a private host';
  }
  return null;
}

/**
 * A private-use URI scheme as RFC 8252 section 7.1 requires it: a domain name the app's publisher
 * controls, in reverse order (`com.example.app`), so at least two labels. A scheme without a
 * period (`javascript`, `data`, `file`, or any short name another app may claim) never matches.
 * `URL` reports the scheme lower-cased, with its colon.
 */
const REVERSE_DOMAIN_SCHEME = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+:$/;
/**
 * IPv4 and name loopback only: the confirm page's `form-action` cannot name an IPv6 literal
 * origin (CSP host sources have no IPv6 form), so a `[::1]` redirect could never complete.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

/**
 * A redirect URI a third-party client may register: an exact HTTPS URL, an HTTP loopback URL on
 * `127.0.0.1` or `localhost` (RFC 8252 section 7.3), or a reverse-domain private-use scheme of a
 * native app (section 7.1); never a fragment or credentials. The authorization endpoint matches the
 * registered string exactly.
 */
export function isAllowedThirdPartyRedirect(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.href !== uri || url.hash !== '' || url.username !== '' || url.password !== '') {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return LOOPBACK_HOSTS.has(url.hostname);
  return REVERSE_DOMAIN_SCHEME.test(url.protocol);
}

/** How a registered third-party redirect URI receives the code. */
export type ThirdPartyRedirectKind = 'https' | 'loopback' | 'private_use_scheme';

/** The kind of a redirect URI that `isAllowedThirdPartyRedirect` accepted. */
export function thirdPartyRedirectKind(uri: string): ThirdPartyRedirectKind {
  const { protocol } = new URL(uri);
  if (protocol === 'https:') return 'https';
  return protocol === 'http:' ? 'loopback' : 'private_use_scheme';
}

/** A display name: plain text without control characters, which the consent page shows escaped. */
const ClientNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u);

/**
 * The members UTS reads. Other members are allowed and kept (a reader ignores what it does not
 * know). A document for a confidential client is refused: UTS serves third-party clients as public
 * clients with PKCE, and a metadata document must never carry a shared secret.
 */
export const ClientMetadataSchema = z
  .looseObject({
    client_id: z.string(),
    client_name: ClientNameSchema,
    redirect_uris: z
      .array(z.string().max(2048).refine(isAllowedThirdPartyRedirect, 'redirect URI not allowed'))
      .min(1)
      .max(32),
    token_endpoint_auth_method: z.literal('none').optional(),
    grant_types: z
      .array(z.enum(['authorization_code', 'refresh_token']))
      .refine(types => types.includes('authorization_code'), 'authorization_code is required')
      .optional(),
    response_types: z.array(z.literal('code')).min(1).optional(),
  })
  .refine(
    document => !('client_secret' in document) && !('client_secret_expires_at' in document),
    'a metadata document carries no client secret'
  );
export type ClientMetadata = z.infer<typeof ClientMetadataSchema>;

/** `fetch` as the deployed Worker calls it; the development entry routes test hosts locally. */
export type MetadataFetcher = (url: string, init: RequestInit) => Promise<Response>;

export type MetadataFetchOutcome =
  | {
      kind: 'document';
      metadata: ClientMetadata;
      etag: string | null;
      cacheSeconds: number;
    }
  /** A revalidation whose cached copy stands, for another `cacheSeconds`. */
  | { kind: 'not_modified'; cacheSeconds: number }
  /** The document is missing or not acceptable; no retry soon will change that. */
  | { kind: 'refused'; reason: string }
  /** The host did not answer in time or failed; a retry can succeed. */
  | { kind: 'unavailable'; reason: string };

/** The cache time of an answer: `max-age` within the bounds, the default without one. */
export function cacheSecondsOf(cacheControl: string | null): number {
  const directives = (cacheControl ?? '')
    .toLowerCase()
    .split(',')
    .map(part => part.trim());
  if (directives.includes('no-store') || directives.includes('no-cache')) {
    return CLIENT_METADATA_MIN_CACHE_SECONDS;
  }
  const maxAge = directives
    .map(directive => /^max-age=(\d{1,10})$/.exec(directive)?.[1])
    .find(value => value !== undefined);
  const seconds = maxAge === undefined ? CLIENT_METADATA_DEFAULT_CACHE_SECONDS : Number(maxAge);
  return Math.min(
    CLIENT_METADATA_MAX_CACHE_SECONDS,
    Math.max(CLIENT_METADATA_MIN_CACHE_SECONDS, seconds)
  );
}

/** The body as text, or null once it passes `maxBytes`; the stream is cancelled at the limit. */
async function boundedText(response: Response, maxBytes: number): Promise<string | null> {
  const declared = response.headers.get('Content-Length');
  if (declared !== null && Number(declared) > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    // The platform types a body chunk as `any`; a fetch body yields bytes, checked here.
    const read: ReadableStreamReadResult<unknown> = await reader.read();
    if (read.done) break;
    const { value } = read;
    if (!(value instanceof Uint8Array)) throw new TypeError('a body chunk is not bytes');
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
}

function isJsonContentType(value: string | null): boolean {
  const type = (value ?? '').split(';')[0].trim().toLowerCase();
  return type === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(type);
}

/**
 * Fetches and checks the document of `clientId`, which `clientIdUrlProblem` already accepted.
 * `etag` revalidates a cached copy. Every failure is an outcome, never a throw.
 */
export async function fetchClientMetadata(
  clientId: string,
  etag: string | null,
  fetcher: MetadataFetcher
): Promise<MetadataFetchOutcome> {
  const signal = AbortSignal.timeout(CLIENT_METADATA_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetcher(clientId, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        Accept: 'application/json',
        ...(etag === null ? {} : { 'If-None-Match': etag }),
      },
      signal,
    });
  } catch {
    return { kind: 'unavailable', reason: 'fetch failed or timed out' };
  }
  const cacheSeconds = cacheSecondsOf(response.headers.get('Cache-Control'));
  if (response.status === 304 && etag !== null) {
    await response.body?.cancel();
    return { kind: 'not_modified', cacheSeconds };
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    if (response.status >= 300 && response.status < 400) {
      return { kind: 'refused', reason: 'redirected' };
    }
    return response.status >= 500 || response.status === 429
      ? { kind: 'unavailable', reason: `status ${response.status}` }
      : { kind: 'refused', reason: `status ${response.status}` };
  }
  if (!isJsonContentType(response.headers.get('Content-Type'))) {
    await response.body?.cancel();
    return { kind: 'refused', reason: 'not JSON' };
  }
  let text: string | null;
  try {
    text = await boundedText(response, CLIENT_METADATA_MAX_BYTES);
  } catch {
    return signal.aborted
      ? { kind: 'unavailable', reason: 'body timed out' }
      : { kind: 'refused', reason: 'body is not UTF-8' };
  }
  if (text === null) return { kind: 'refused', reason: 'body too large' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: 'refused', reason: 'body is not JSON' };
  }
  const parsed = ClientMetadataSchema.safeParse(value);
  if (!parsed.success) return { kind: 'refused', reason: 'document does not validate' };
  if (parsed.data.client_id !== clientId) {
    return { kind: 'refused', reason: 'document names another client id' };
  }
  const responseEtag = response.headers.get('ETag');
  return {
    kind: 'document',
    metadata: parsed.data,
    etag: responseEtag !== null && responseEtag.length <= MAX_ETAG_LENGTH ? responseEtag : null,
    cacheSeconds,
  };
}
