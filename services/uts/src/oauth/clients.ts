import { oauthError } from './errors';
import type { Params } from './params';

/**
 * OAuth clients (design 5.9). A first-party client is pre-registered here with a fixed client id,
 * a client class (which sets its refresh lifetimes, design 5.3) and its redirect rule. A
 * third-party client id is the HTTPS URL of its Client ID Metadata Document; the identity store
 * caches the document (`uts.third_party_clients`) with its redirect URIs.
 */

export type FirstPartyClient = {
  clientId: string;
  name: string;
  clientClass: 'desktop' | 'mobile';
  /**
   * RFC 8252 section 7.3: a native app receives the code on a loopback address. Any port is
   * allowed, the host is `127.0.0.1` or `[::1]` (never `localhost`, RFC 8252 section 8.3), and the
   * path is fixed.
   */
  loopbackPath: string;
};

/**
 * The first-party clients that use the authorization endpoint today: the CLI, which the VS Code
 * and JetBrains extensions drive (design 5.5). A client joins this list when it moves to UTS.
 */
const FIRST_PARTY_CLIENTS: ReadonlyMap<string, FirstPartyClient> = new Map([
  [
    'kilo-cli',
    { clientId: 'kilo-cli', name: 'Kilo CLI', clientClass: 'desktop', loopbackPath: '/callback' },
  ],
]);

/** The shape `uts.third_party_clients` enforces: an HTTPS URL with a path and no query. */
const THIRD_PARTY_CLIENT_ID = /^https:\/\/[^/?#]+\/[^?#]+$/;
const MAX_CLIENT_ID_LENGTH = 2048;

export type ClientIdentity =
  | { kind: 'first_party'; client: FirstPartyClient }
  | { kind: 'third_party'; clientId: string }
  | { kind: 'unknown' };

export function identifyClient(clientId: string): ClientIdentity {
  const client = FIRST_PARTY_CLIENTS.get(clientId);
  if (client !== undefined) return { kind: 'first_party', client };
  if (clientId.length <= MAX_CLIENT_ID_LENGTH && THIRD_PARTY_CLIENT_ID.test(clientId)) {
    return { kind: 'third_party', clientId };
  }
  return { kind: 'unknown' };
}

/**
 * The client a token, revocation or introspection request names. A public client identifies by
 * `client_id` alone (RFC 6749 section 2.3); an unknown client gets `invalid_client` (401).
 */
export function requestClient(
  params: Params
): Exclude<ClientIdentity, { kind: 'unknown' }> | Response {
  const clientId = params.one('client_id');
  if (clientId.status !== 'present') {
    return oauthError('invalid_request', 400, 'client_id is required once');
  }
  const identity = identifyClient(clientId.value);
  if (identity.kind === 'unknown') return oauthError('invalid_client', 401, 'unknown client');
  return identity;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);

/** True when `redirectUri` is a loopback redirect of `client` on any port. */
export function isLoopbackRedirect(client: FirstPartyClient, redirectUri: string): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  return (
    url.protocol === 'http:' &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    url.port !== '' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === client.loopbackPath &&
    url.search === '' &&
    url.hash === '' &&
    // The parsed form must be the sent form, so no normalization hides another target.
    url.href === redirectUri
  );
}
