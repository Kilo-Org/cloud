import type { UtsEnvironment } from './environment';
import { resourceOriginOf } from './oauth';
import { KILO_API_AUDIENCE } from './scopes';

/**
 * UTS first-party clients (design 5.5, 5.9): pre-registered with a fixed client id. A public
 * native client authenticates with PKCE and a DPoP-bound grant and receives its code on a loopback
 * address (desktop, RFC 8252 section 7.3) or one private-use-scheme URI (mobile, RFC 8252 section
 * 7.1). A confidential web client is a backend (the web BFF) that authenticates to the token
 * endpoint with a private-key JWT (RFC 7523, `private_key_jwt`) and receives its code on exact
 * HTTPS redirect URIs, one set per environment. The scope registry's `allowedClients` names these
 * ids; the authorization endpoint serves a client once it moves to UTS.
 */
export type UtsFirstPartyClient =
  | {
      kind: 'public_native';
      clientId: string;
      name: string;
      /** Sets the refresh grant's lifetimes (design 5.3). */
      clientClass: 'desktop' | 'mobile';
      redirect: { kind: 'loopback'; path: string } | { kind: 'private_use_scheme'; uri: string };
      /**
       * `required`: design 5.5 asks the client for device attestation (`attestation.ts`), so the
       * authorization endpoint serves it only where the environment's attestation config is
       * complete, or in development with no attestation config at all (decision Q67).
       */
      attestation: 'required' | 'none';
    }
  | {
      kind: 'confidential_web';
      clientId: string;
      name: string;
      tokenEndpointAuthMethod: 'private_key_jwt';
      /** The exact redirect URIs the client may name, per environment. */
      redirectUris: Readonly<Record<UtsEnvironment, readonly string[]>>;
    };

/** The CLI, which the VS Code and JetBrains extensions drive (design 5.5). */
export const KILO_CLI_CLIENT_ID = 'kilo-cli';

/** The web BFF of the web app (design 5.1, 5.5). */
export const KILO_WEB_CLIENT_ID = 'kilo-web';

/** The mobile app, which signs in through the system browser (design 5.5). */
export const KILO_MOBILE_CLIENT_ID = 'kilo-mobile';

/** Where the web BFF receives the authorization code, on its own origin. */
export const KILO_WEB_CALLBACK_PATH = '/api/auth/uts/callback';

/** The BFF's redirect URI: its callback path on the environment's `kilo-api` resource origin. */
function kiloWebRedirectUris(environment: UtsEnvironment): readonly string[] {
  const origin = resourceOriginOf(environment, KILO_API_AUDIENCE);
  return origin === null ? [] : [`${origin}${KILO_WEB_CALLBACK_PATH}`];
}

export const UTS_FIRST_PARTY_CLIENTS: readonly UtsFirstPartyClient[] = [
  {
    kind: 'public_native',
    clientId: KILO_CLI_CLIENT_ID,
    name: 'Kilo CLI',
    clientClass: 'desktop',
    redirect: { kind: 'loopback', path: '/callback' },
    attestation: 'none',
  },
  {
    kind: 'confidential_web',
    clientId: KILO_WEB_CLIENT_ID,
    name: 'Kilo web app',
    tokenEndpointAuthMethod: 'private_key_jwt',
    redirectUris: {
      production: kiloWebRedirectUris('production'),
      staging: kiloWebRedirectUris('staging'),
      development: kiloWebRedirectUris('development'),
    },
  },
  {
    kind: 'public_native',
    clientId: KILO_MOBILE_CLIENT_ID,
    name: 'Kilo mobile app',
    clientClass: 'mobile',
    redirect: { kind: 'private_use_scheme', uri: 'com.kilocode.kiloapp:/oauth/callback' },
    attestation: 'required',
  },
];

/** The registered first-party client with `clientId`, or null. */
export function firstPartyClient(clientId: string): UtsFirstPartyClient | null {
  return UTS_FIRST_PARTY_CLIENTS.find(client => client.clientId === clientId) ?? null;
}
