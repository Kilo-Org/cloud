import { describe, expect, it } from 'vitest';
import {
  CLIENT_METADATA_MAX_BYTES,
  type MetadataFetcher,
  cacheSecondsOf,
  clientIdUrlProblem,
  fetchClientMetadata,
  isAllowedThirdPartyRedirect,
} from '../../src/third-party/metadata';

/** Client ID Metadata Documents: the URL guards, the redirect rule and the fetch checks. */

const CLIENT_ID = 'https://client.example.com/oauth/client.json';
const document = (overrides: Record<string, unknown> = {}) => ({
  client_id: CLIENT_ID,
  client_name: 'Example MCP client',
  redirect_uris: ['https://client.example.com/callback', 'http://127.0.0.1:33418/callback'],
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  logo_uri: 'https://client.example.com/logo.png',
  ...overrides,
});

/** A fetcher that answers once with `response` and records the request it got. */
function answering(response: Response) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetcher: MetadataFetcher = async (url, init) => {
    requests.push({ url, init });
    return response;
  };
  return { fetcher, requests };
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

describe('client id URL guard', () => {
  it('accepts an HTTPS URL with a path on a public domain name', () => {
    expect(clientIdUrlProblem(CLIENT_ID)).toBeNull();
    expect(clientIdUrlProblem('https://mcp.example.org/.well-known/client')).toBeNull();
  });

  it.each([
    ['http://client.example.com/client.json', 'not HTTPS'],
    ['https://client.example.com', 'not in canonical form'],
    ['https://client.example.com/', 'has no path'],
    ['https://client.example.com:8443/client.json', 'names a port'],
    ['https://user:pw@client.example.com/client.json', 'carries credentials'],
    ['https://client.example.com/client.json?x=1', 'has a query or fragment'],
    ['https://client.example.com/client.json#x', 'has a query or fragment'],
    ['https://CLIENT.example.com/client.json', 'not in canonical form'],
    ['https://127.0.0.1/client.json', 'names an IP address'],
    ['https://10.0.0.8/client.json', 'names an IP address'],
    ['https://[::1]/client.json', 'names an IP address'],
    ['https://[fd00::1]/client.json', 'names an IP address'],
    ['https://0x7f000001/client.json', 'not in canonical form'],
    ['https://localhost/client.json', 'does not name a domain'],
    ['https://intranet/client.json', 'does not name a domain'],
    ['https://printer.local/client.json', 'names a private host'],
    ['https://db.internal/client.json', 'names a private host'],
    ['https://app.localhost/client.json', 'names a private host'],
    ['https://router.home.arpa/client.json', 'names a private host'],
    ['not a url', 'not a URL'],
    [`https://client.example.com/${'a'.repeat(2048)}`, 'too long'],
  ])('refuses %s: %s', (clientId, problem) => {
    expect(clientIdUrlProblem(clientId)).toBe(problem);
  });
});

describe('third-party redirect URIs', () => {
  it.each([
    'https://client.example.com/callback',
    'http://127.0.0.1:33418/callback',
    'http://localhost:6274/oauth/callback',
    'cursor://anysphere.cursor-mcp/oauth/callback',
    'com.example.app:/oauth/callback',
  ])('allows %s', uri => {
    expect(isAllowedThirdPartyRedirect(uri)).toBe(true);
  });

  it.each([
    'http://client.example.com/callback',
    'javascript:alert(1)',
    'data:text/html,hi',
    'file:///etc/passwd',
    'https://client.example.com/callback#fragment',
    'https://user@client.example.com/callback',
    'HTTPS://client.example.com/callback',
    'relative/callback',
    // The confirm page's `form-action` cannot name an IPv6 literal origin.
    'http://[::1]:33418/callback',
  ])('refuses %s', uri => {
    expect(isAllowedThirdPartyRedirect(uri)).toBe(false);
  });
});

describe('cache time', () => {
  it.each([
    [null, 3600],
    ['max-age=600', 600],
    ['public, max-age=7200', 7200],
    ['max-age=10', 300],
    ['max-age=999999', 86_400],
    ['no-store', 300],
    ['no-cache, max-age=600', 300],
    ['max-age=abc', 3600],
  ])('reads %s as %i seconds', (header, seconds) => {
    expect(cacheSecondsOf(header)).toBe(seconds);
  });
});

describe('metadata fetch', () => {
  it('fetches without following redirects and returns the checked document, ETag and cache time', async () => {
    const { fetcher, requests } = answering(
      json(document(), { ETag: '"v1"', 'Cache-Control': 'max-age=900' })
    );
    const outcome = await fetchClientMetadata(CLIENT_ID, null, fetcher);
    expect(outcome).toMatchObject({ kind: 'document', etag: '"v1"', cacheSeconds: 900 });
    if (outcome.kind !== 'document') throw new Error('expected a document');
    expect(outcome.metadata.client_name).toBe('Example MCP client');
    expect(outcome.metadata.logo_uri).toBe('https://client.example.com/logo.png');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(CLIENT_ID);
    expect(requests[0].init.redirect).toBe('manual');
    expect(requests[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('revalidates with the ETag and keeps the cached copy on 304', async () => {
    const { fetcher, requests } = answering(
      new Response(null, { status: 304, headers: { 'Cache-Control': 'max-age=1200' } })
    );
    expect(await fetchClientMetadata(CLIENT_ID, '"v1"', fetcher)).toEqual({
      kind: 'not_modified',
      cacheSeconds: 1200,
    });
    expect(new Headers(requests[0].init.headers).get('If-None-Match')).toBe('"v1"');
  });

  it.each<[string, Response, string]>([
    [
      'a redirect',
      new Response(null, { status: 302, headers: { Location: 'http://10.0.0.1/' } }),
      'redirected',
    ],
    ['a missing document', new Response('gone', { status: 404 }), 'status 404'],
    [
      'another content type',
      new Response(JSON.stringify(document()), { headers: { 'Content-Type': 'text/html' } }),
      'not JSON',
    ],
    [
      'a declared body over the limit',
      new Response('{}', {
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(CLIENT_METADATA_MAX_BYTES + 1),
        },
      }),
      'body too large',
    ],
    [
      'a streamed body over the limit',
      json(document({ padding: 'x'.repeat(CLIENT_METADATA_MAX_BYTES) })),
      'body too large',
    ],
    [
      'a body that is not JSON',
      new Response('{', { headers: { 'Content-Type': 'application/json' } }),
      'body is not JSON',
    ],
    [
      'another client id',
      json(document({ client_id: `${CLIENT_ID}x` })),
      'document names another client id',
    ],
    ['no redirect URI', json(document({ redirect_uris: [] })), 'document does not validate'],
    [
      'a refused redirect URI',
      json(document({ redirect_uris: ['javascript:alert(1)'] })),
      'document does not validate',
    ],
    [
      'an IPv6 loopback redirect URI',
      json(document({ redirect_uris: ['http://[::1]:33418/callback'] })),
      'document does not validate',
    ],
    [
      'a confidential client',
      json(document({ token_endpoint_auth_method: 'client_secret_basic' })),
      'document does not validate',
    ],
    [
      'a client secret',
      json(document({ client_secret: 'synthetic' })),
      'document does not validate',
    ],
    [
      'a name with control characters',
      json(document({ client_name: 'Example\u0000client' })),
      'document does not validate',
    ],
    [
      'grant types without the code grant',
      json(document({ grant_types: ['refresh_token'] })),
      'document does not validate',
    ],
  ])('refuses %s', async (_name, response, reason) => {
    expect(await fetchClientMetadata(CLIENT_ID, null, answering(response).fetcher)).toEqual({
      kind: 'refused',
      reason,
    });
  });

  it.each<[string, MetadataFetcher, string]>([
    [
      'a network failure',
      async () => {
        throw new TypeError('network');
      },
      'fetch failed or timed out',
    ],
    ['a server error', async () => new Response('', { status: 503 }), 'status 503'],
    ['a rate limit', async () => new Response('', { status: 429 }), 'status 429'],
  ])('answers unavailable for %s', async (_name, fetcher, reason) => {
    expect(await fetchClientMetadata(CLIENT_ID, null, fetcher)).toEqual({
      kind: 'unavailable',
      reason,
    });
  });
});
