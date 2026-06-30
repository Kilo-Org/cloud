import { browser } from '#imports';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { RemoteMcpOAuthState, RemoteMcpServer } from '../../src/shared/remote-mcp';
import type { RemoteMcpStorageArea } from '../../src/shared/remote-mcp-storage';
import {
  loadRemoteMcpStore,
  saveRemoteMcpStore,
  upsertRemoteMcpServer,
} from '../../src/shared/remote-mcp-storage';
import {
  buildPublicClientMetadata,
  parseAuthorizationRedirect,
} from '../../src/shared/remote-mcp-oauth';

const REDIRECT_PATH = 'remote-mcp';

/**
 * SDK `OAuthClientProvider` backed by a single server's persisted OAuth state.
 *
 * The SDK transport drives the flow: on an unauthorized connection it calls
 * `redirectToAuthorization`, which launches the browser auth flow and stashes
 * the returned `code`. The caller then reads it via `takeAuthorizationCode()`
 * and passes it to `transport.finishAuth(code)`.
 */
export interface RemoteMcpOAuthProvider extends OAuthClientProvider {
  /** Returns the authorization code captured by the last redirect, or undefined. */
  takeAuthorizationCode(): string | undefined;
}

export const createRemoteMcpOAuthProvider = ({
  server,
  storageArea,
}: {
  readonly server: RemoteMcpServer;
  readonly storageArea: RemoteMcpStorageArea;
}): RemoteMcpOAuthProvider => {
  const redirectUrl = browser.identity.getRedirectURL(REDIRECT_PATH);
  const clientMetadata = buildPublicClientMetadata(redirectUrl);
  let authorizationCode: string | undefined = undefined;

  const readOAuthState = async (): Promise<RemoteMcpOAuthState | undefined> => {
    const store = await loadRemoteMcpStore(storageArea);
    const current = store.servers.find(candidate => candidate.id === server.id);
    return current?.auth.type === 'oauth' ? current.auth.oauth : undefined;
  };

  // Merge a partial OAuth state into this server's persisted oauth blob.
  // Passing no patch clears the server's oauth state entirely.
  const updateOAuthState = async (patch?: Partial<RemoteMcpOAuthState>): Promise<void> => {
    const store = await loadRemoteMcpStore(storageArea);
    const current = store.servers.find(candidate => candidate.id === server.id);
    if (current === undefined) {
      return;
    }

    const existing = current.auth.type === 'oauth' ? current.auth.oauth : undefined;
    const oauth = patch === undefined ? undefined : { ...existing, ...patch };

    const next = upsertRemoteMcpServer(store, {
      ...current,
      auth: { oauth, type: 'oauth' },
    });
    await saveRemoteMcpStore(storageArea, next);
  };

  return {
    async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
      const state = await readOAuthState();
      return state?.clientInformation;
    },

    get clientMetadata(): OAuthClientMetadata {
      return clientMetadata;
    },

    async codeVerifier(): Promise<string> {
      const state = await readOAuthState();
      if (state?.codeVerifier === undefined) {
        throw new Error('No OAuth code verifier is saved for this server.');
      }
      return state.codeVerifier;
    },

    async invalidateCredentials(
      scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'
    ): Promise<void> {
      if (scope === 'all') {
        await updateOAuthState();
        authorizationCode = undefined;
        return;
      }
      if (scope === 'client') {
        await updateOAuthState({ clientInformation: undefined });
      }
      if (scope === 'tokens') {
        await updateOAuthState({ tokens: undefined });
      }
      if (scope === 'verifier') {
        await updateOAuthState({ codeVerifier: undefined });
        authorizationCode = undefined;
      }
    },

    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
      const redirect = await browser.identity.launchWebAuthFlow({
        interactive: true,
        url: authorizationUrl.toString(),
      });
      if (redirect === undefined) {
        throw new Error('Authorization flow returned no redirect URL.');
      }
      authorizationCode = parseAuthorizationRedirect(redirect);
    },

    get redirectUrl(): string {
      return redirectUrl;
    },

    async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
      await updateOAuthState({ clientInformation });
    },

    async saveCodeVerifier(codeVerifier: string): Promise<void> {
      await updateOAuthState({ codeVerifier });
    },

    async saveTokens(tokens: OAuthTokens): Promise<void> {
      await updateOAuthState({ tokens });
    },

    takeAuthorizationCode(): string | undefined {
      const code = authorizationCode;
      authorizationCode = undefined;
      return code;
    },

    async tokens(): Promise<OAuthTokens | undefined> {
      const state = await readOAuthState();
      return state?.tokens;
    },
  };
};
