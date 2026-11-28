import type { UtsEnvironment, UtsFirstPartyClient } from '@kilocode/uts-contracts';
import type { AttestationPolicy } from '../attest/config';
import { matchesPrivateUseRedirect } from '../signin/native/redirect';
import { oauthError } from './errors';
import type { Params } from './params';

/**
 * OAuth clients (design 5.9). A first-party client is pre-registered here with a fixed client id,
 * a client class (which sets its refresh lifetimes, design 5.3) and its redirect rule. A
 * third-party client id is the HTTPS URL of its Client ID Metadata Document; the identity store
 * caches the document (`uts.third_party_clients`) with its redirect URIs.
 */

/**
 * Where a first-party client receives its code. A desktop app uses a loopback address (RFC 8252
 * section 7.3): any port, the host `127.0.0.1` (never `localhost`, RFC 8252 section 8.3; never
 * `[::1]`, because the confirm page's `form-action` cannot name an IPv6 literal origin, so the
 * confirm POST could not redirect there), and a fixed path. A mobile app uses one
 * private-use-scheme URI (RFC 8252 section 7.1).
 */
export type RedirectRule =
  | { kind: 'loopback'; path: string }
  | { kind: 'private_use_scheme'; uri: string };

export type FirstPartyClient = {
  clientId: string;
  name: string;
  clientClass: 'desktop' | 'mobile';
  redirect: RedirectRule;
  /** Whether the client may sign in with the RFC 8628 device grant (design 5.5). */
  deviceGrant: boolean;
  /**
   * `required`: design 5.5 asks the client for device attestation (App Attest, Play Integrity) at
   * each code exchange (src/attest/gate.ts), so the authorization endpoint serves the client only
   * where the environment's attestation policy allows it (`clientServedIn`). `none`: no
   * attestation.
   */
  attestation: 'required' | 'none';
};

/**
 * The first-party clients (design 5.5): the CLI, which the VS Code and JetBrains extensions drive,
 * with the device grant as its fallback, and the mobile app, which signs in through the system
 * browser. A client joins this list when it moves to UTS. Exported for `test/repo`, which holds the
 * attestation-required ids equal to the backstop trigger's list (migration 0017).
 */
export const FIRST_PARTY_CLIENTS: ReadonlyMap<string, FirstPartyClient> = new Map([
  [
    'kilo-cli',
    {
      clientId: 'kilo-cli',
      name: 'Kilo CLI',
      clientClass: 'desktop',
      redirect: { kind: 'loopback', path: '/callback' },
      deviceGrant: true,
      attestation: 'none',
    },
  ],
  [
    'kilo-mobile',
    {
      clientId: 'kilo-mobile',
      name: 'Kilo mobile app',
      clientClass: 'mobile',
      redirect: { kind: 'private_use_scheme', uri: 'com.kilocode.kiloapp:/oauth/callback' },
      deviceGrant: false,
      attestation: 'required',
    },
  ],
]);

/**
 * Whether the authorization endpoint serves `client` under the environment's attestation policy.
 * A client that needs device attestation is refused wherever the attestation config is not
 * complete (src/attest/config.ts), so no grant exists for it there; every later step (refresh,
 * tickets) needs such a grant.
 */
export function clientServedIn(
  client: FirstPartyClient,
  attestation: AttestationPolicy['kind']
): boolean {
  return client.attestation === 'none' || attestation !== 'refused';
}

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

/** The first-party client a request names, or the error response; third-party clients refused. */
export function requestFirstPartyClient(params: Params): FirstPartyClient | Response {
  const identity = requestClient(params);
  if (identity instanceof Response) return identity;
  if (identity.kind !== 'first_party') {
    return oauthError('unauthorized_client', 400, 'this endpoint serves first-party clients only');
  }
  return identity.client;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1']);

/** True when `redirectUri` is a loopback redirect on any port with the rule's path. */
function isLoopbackRedirect(path: string, redirectUri: string): boolean {
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
    url.pathname === path &&
    url.search === '' &&
    url.hash === '' &&
    // The parsed form must be the sent form, so no normalization hides another target.
    url.href === redirectUri
  );
}

/** True when `redirectUri` is the redirect `client` registered. */
export function isRegisteredRedirect(client: FirstPartyClient, redirectUri: string): boolean {
  return client.redirect.kind === 'loopback'
    ? isLoopbackRedirect(client.redirect.path, redirectUri)
    : matchesPrivateUseRedirect(client.redirect.uri, redirectUri);
}

/** True when `redirectUri` is one of the exact URIs the web client registered for `environment`. */
export function isRegisteredWebRedirect(
  client: Extract<UtsFirstPartyClient, { kind: 'confidential_web' }>,
  environment: UtsEnvironment,
  redirectUri: string
): boolean {
  return client.redirectUris[environment].includes(redirectUri);
}
