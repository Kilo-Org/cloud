import { Effect, Either } from 'effect';
import * as Crypto from 'expo-crypto';
import {
  type RemoteMcpOAuthClientMetadata,
  remoteMcpSignIn,
  type RemoteMcpSignInProvider,
} from '@kilocode/harness-sdk/plugins/remote-mcp';

import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';

import { openRemoteMcpAuthorization, REMOTE_MCP_REDIRECT_URL } from './remote-mcp-oauth-browser';
import {
  readRemoteMcpOAuth,
  type RemoteMcpOAuthState,
  writeRemoteMcpOAuth,
} from './remote-mcp-oauth-store';
import { type StoredRemoteMcpServer } from './remote-mcp-store';

/**
 * The MCP SDK's OAuth provider for one server, kept on the secure store.
 *
 * A background provider is what discovery and calls run with: it adds the
 * stored token and lets the SDK refresh it, but it never opens a browser and
 * never writes a PKCE verifier, so a chat that opens while a person is signing
 * in cannot replace the verifier that person's code was issued for. A sign-in
 * provider opens the browser and keeps the code its redirect carries.
 *
 * Every write is fenced to the account that made the provider: a token that
 * arrives after a sign-out is dropped, not saved for the next account.
 */

type OAuthServer = Pick<StoredRemoteMcpServer, 'id' | 'url'>;

const clientMetadata: RemoteMcpOAuthClientMetadata = {
  client_name: 'Kilo',
  redirect_uris: [REMOTE_MCP_REDIRECT_URL],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

/** The authorization code a redirect carries, once it is the answer to this request. */
export function authorizationCodeOf(redirect: string, state: string): string {
  const params = new URL(redirect).searchParams;
  const error = params.get('error');
  if (error !== null) {
    const description = params.get('error_description');
    throw new Error(description === null ? error : `${error}: ${description}`);
  }
  if (params.get('state') !== state) {
    throw new Error('The authorization redirect answered another request.');
  }
  const code = params.get('code');
  if (code === null) {
    throw new Error('The authorization redirect carried no code.');
  }
  return code;
}

type OAuthPatch = Omit<Partial<RemoteMcpOAuthState>, 'url'>;

/** What each of the SDK's invalidation scopes takes away. Discovery is not stored. */
const CLEARED = {
  all: { tokens: undefined, client: undefined, verifier: undefined },
  client: { client: undefined },
  tokens: { tokens: undefined },
  verifier: { verifier: undefined },
  discovery: {},
} satisfies Record<'all' | 'client' | 'tokens' | 'verifier' | 'discovery', OAuthPatch>;

type SignInProvider = RemoteMcpSignInProvider & {
  /** Whether the person closed the browser without finishing. */
  readonly turnedBack: () => boolean;
};

function oauthProvider(server: OAuthServer, interactive: boolean): SignInProvider {
  const epoch = currentAuthEpoch();
  const state = Crypto.randomUUID();
  let code: string | undefined = undefined;
  let turnedBack = false;
  const save = async (patch: OAuthPatch) => {
    if (isCurrentAuthEpoch(epoch)) {
      await writeRemoteMcpOAuth(server.id, server.url, patch);
    }
  };
  return {
    redirectUrl: REMOTE_MCP_REDIRECT_URL,
    clientMetadata,
    state: () => state,
    clientInformation: async () => {
      const stored = await readRemoteMcpOAuth(server.id, server.url);
      return stored?.client;
    },
    saveClientInformation: async client => {
      await save({ client });
    },
    tokens: async () => {
      const stored = await readRemoteMcpOAuth(server.id, server.url);
      return stored?.tokens;
    },
    saveTokens: async tokens => {
      await save({ tokens });
    },
    saveCodeVerifier: async verifier => {
      if (interactive) {
        await save({ verifier });
      }
    },
    codeVerifier: async () => {
      const stored = await readRemoteMcpOAuth(server.id, server.url);
      if (stored?.verifier === undefined) {
        throw new Error('No PKCE verifier is saved for this server.');
      }
      return stored.verifier;
    },
    invalidateCredentials: async scope => {
      await save(CLEARED[scope]);
    },
    redirectToAuthorization: async url => {
      if (!interactive) {
        return;
      }
      const redirect = await openRemoteMcpAuthorization(url.href);
      turnedBack = redirect === null;
      code = redirect === null ? undefined : authorizationCodeOf(redirect, state);
    },
    takeAuthorizationCode: () => {
      const taken = code;
      code = undefined;
      return taken;
    },
    turnedBack: () => turnedBack,
  };
}

/** The provider discovery and calls run with: refresh only, never a browser. */
export function backgroundOAuthProvider(server: OAuthServer): RemoteMcpSignInProvider {
  return oauthProvider(server, false);
}

export type RemoteMcpSignInOutcome = 'signed-in' | 'turned-back' | 'failed';

/** Signs a person in to one server in the browser, and says how it ended. */
export async function signInRemoteMcpServer(
  server: StoredRemoteMcpServer
): Promise<RemoteMcpSignInOutcome> {
  const authProvider = oauthProvider(server, true);
  const outcome = await Effect.runPromise(
    Effect.either(
      remoteMcpSignIn(
        { id: server.id, name: server.name, url: server.url, auth: { type: 'oauth' } },
        { fetch, authProvider }
      )
    )
  );
  if (Either.isRight(outcome)) {
    return 'signed-in';
  }
  return authProvider.turnedBack() ? 'turned-back' : 'failed';
}
