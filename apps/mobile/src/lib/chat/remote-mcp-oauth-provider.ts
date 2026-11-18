import {
  type RemoteMcpOAuthClientMetadata,
  type RemoteMcpSignInProvider,
} from '@kilocode/harness-sdk/plugins/remote-mcp';

import { currentAuthEpoch } from '@/lib/auth/auth-epoch';

import {
  readRemoteMcpOAuth,
  type RemoteMcpOAuthState,
  writeRemoteMcpOAuth,
} from './remote-mcp-oauth-store';
import { type StoredRemoteMcpServer } from './remote-mcp-store';

/**
 * The MCP SDK's OAuth provider for one server, kept on the secure store.
 *
 * Without a sign-in, the provider is what discovery and calls run with: it
 * adds the stored token and lets the SDK refresh it, but it never opens a
 * browser and never writes a PKCE verifier, so a chat that opens while a person
 * is signing in cannot replace the verifier that person's code was issued for.
 *
 * Every write is fenced to the account that made the provider: a token that
 * arrives after a sign-out is dropped, not saved for the next account.
 */

type OAuthServer = Pick<StoredRemoteMcpServer, 'id' | 'url'>;

export const REMOTE_MCP_REDIRECT_URL = 'kiloapp:///remote-mcp';

/** What a sign-in adds: the `state` it sent, and the browser that answers the code. */
export type RemoteMcpSignIn = {
  readonly state: string;
  /** The authorization code the redirect carried, or null when the person turned back. */
  readonly authorize: (url: URL) => Promise<string | null>;
};

export type RemoteMcpOAuthProvider = RemoteMcpSignInProvider & {
  /** Whether the person closed the browser without finishing. */
  readonly turnedBack: () => boolean;
};

const clientMetadata: RemoteMcpOAuthClientMetadata = {
  client_name: 'Kilo',
  redirect_uris: [REMOTE_MCP_REDIRECT_URL],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

type OAuthPatch = Omit<Partial<RemoteMcpOAuthState>, 'url'>;

/** What each of the SDK's invalidation scopes takes away. Discovery is not stored. */
const CLEARED = {
  all: { tokens: undefined, client: undefined, verifier: undefined },
  client: { client: undefined },
  tokens: { tokens: undefined },
  verifier: { verifier: undefined },
  discovery: {},
} satisfies Record<'all' | 'client' | 'tokens' | 'verifier' | 'discovery', OAuthPatch>;

export function remoteMcpOAuthProvider(
  server: OAuthServer,
  signIn?: RemoteMcpSignIn
): RemoteMcpOAuthProvider {
  const epoch = currentAuthEpoch();
  let code: string | undefined = undefined;
  let turnedBack = false;
  /* A sign-in registers its own client (RFC 7591) rather than reusing the
     stored one: a server that lost its registrations answers an unknown
     client on the authorize page without redirecting, and the person could
     then never sign in again. */
  let registered: RemoteMcpOAuthState['client'] = undefined;
  const save = async (patch: OAuthPatch) => {
    await writeRemoteMcpOAuth({ id: server.id, url: server.url, epoch }, patch);
  };
  return {
    redirectUrl: REMOTE_MCP_REDIRECT_URL,
    clientMetadata,
    ...(signIn === undefined ? {} : { state: () => signIn.state }),
    clientInformation: async () => {
      if (signIn !== undefined) {
        return registered;
      }
      const stored = await readRemoteMcpOAuth(server.id, server.url);
      return stored?.client;
    },
    saveClientInformation: async client => {
      registered = client;
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
      if (signIn !== undefined) {
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
      if (signIn === undefined) {
        return;
      }
      const answered = await signIn.authorize(url);
      turnedBack = answered === null;
      code = answered ?? undefined;
    },
    takeAuthorizationCode: () => {
      const taken = code;
      code = undefined;
      return taken;
    },
    turnedBack: () => turnedBack,
  };
}
