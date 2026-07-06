import { describe, expect, it, vi } from 'vitest';
import type { RemoteMcpServer } from '../../src/shared/remote-mcp';
import type { RemoteMcpStorageArea } from '../../src/shared/remote-mcp-storage';
import { REMOTE_MCP_STORAGE_KEY } from '../../src/shared/remote-mcp-storage';

const mocks = vi.hoisted(() => ({
  getRedirectURL: vi.fn<(path?: string) => string>(),
  launchWebAuthFlow: vi.fn<(details: { interactive: boolean; url: string }) => Promise<string>>(),
}));

// eslint-disable-next-line vitest/prefer-import-in-mock, jest/no-untyped-mock-factory
vi.mock('#imports', () => ({
  browser: {
    identity: {
      getRedirectURL: mocks.getRedirectURL,
      launchWebAuthFlow: mocks.launchWebAuthFlow,
    },
  },
}));

// eslint-disable-next-line import/first
import { createRemoteMcpOAuthProvider } from './remote-mcp-oauth-provider';

const baseServer = (overrides: Partial<RemoteMcpServer> = {}): RemoteMcpServer => ({
  allowInSafeMode: false,
  auth: { type: 'oauth' },
  cachedTools: [],
  displayName: 'Test Server',
  enabled: true,
  id: 'srv-1',
  slug: 'test-server',
  status: 'untested',
  url: 'https://mcp.example.com/',
  ...overrides,
});

const createStorage = (server: RemoteMcpServer): RemoteMcpStorageArea => {
  let value: unknown = { servers: [server] };
  return {
    getItem: key => {
      expect(key).toBe(REMOTE_MCP_STORAGE_KEY);
      return value;
    },
    setItem: (key, next) => {
      expect(key).toBe(REMOTE_MCP_STORAGE_KEY);
      value = next;
    },
  };
};

const setupMocks = () => {
  mocks.getRedirectURL.mockReset();
  mocks.launchWebAuthFlow.mockReset();
  mocks.getRedirectURL.mockReturnValue('https://abc.chromiumapp.org/remote-mcp');
};

describe('oauth provider creation', () => {
  it('reports the browser redirect URL and public client metadata', () => {
    setupMocks();
    const provider = createRemoteMcpOAuthProvider({
      server: baseServer(),
      storageArea: createStorage(baseServer()),
    });

    expect(mocks.getRedirectURL).toHaveBeenCalledWith('remote-mcp');
    expect(provider.redirectUrl).toBe('https://abc.chromiumapp.org/remote-mcp');
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe('none');
    expect(provider.clientMetadata.redirect_uris).toStrictEqual([
      'https://abc.chromiumapp.org/remote-mcp',
    ]);
  });

  it('persists client information and reads it back', async () => {
    setupMocks();
    const storage = createStorage(baseServer());
    const provider = createRemoteMcpOAuthProvider({ server: baseServer(), storageArea: storage });

    await provider.saveClientInformation?.({ client_id: 'client-abc' });

    const reloaded = createRemoteMcpOAuthProvider({
      server: baseServer(),
      storageArea: storage,
    });
    await expect(reloaded.clientInformation()).resolves.toMatchObject({ client_id: 'client-abc' });
  });

  it('persists tokens and reads them back', async () => {
    setupMocks();
    const storage = createStorage(baseServer());
    const provider = createRemoteMcpOAuthProvider({ server: baseServer(), storageArea: storage });

    await provider.saveTokens({ access_token: 'access-123', token_type: 'Bearer' });

    const reloaded = createRemoteMcpOAuthProvider({
      server: baseServer(),
      storageArea: storage,
    });
    await expect(reloaded.tokens()).resolves.toMatchObject({ access_token: 'access-123' });
  });

  it('persists the code verifier and reads it back', async () => {
    setupMocks();
    const storage = createStorage(baseServer());
    const provider = createRemoteMcpOAuthProvider({ server: baseServer(), storageArea: storage });

    await provider.saveCodeVerifier('verifier-xyz');

    const reloaded = createRemoteMcpOAuthProvider({
      server: baseServer(),
      storageArea: storage,
    });
    await expect(reloaded.codeVerifier()).resolves.toBe('verifier-xyz');
  });

  it('launches the web auth flow with the authorization URL', async () => {
    setupMocks();
    mocks.launchWebAuthFlow.mockResolvedValueOnce(
      'https://abc.chromiumapp.org/remote-mcp?code=the-code&state=the-state'
    );
    const provider = createRemoteMcpOAuthProvider({
      server: baseServer(),
      storageArea: createStorage(baseServer()),
    });

    await provider.redirectToAuthorization(new URL('https://auth.example.com/authorize?x=1'));

    expect(mocks.launchWebAuthFlow).toHaveBeenCalledWith({
      interactive: true,
      url: 'https://auth.example.com/authorize?x=1',
    });
    expect(provider.takeAuthorizationCode()).toBe('the-code');
  });

  it('clears tokens and verifier when invalidating', async () => {
    setupMocks();
    const storage = createStorage(baseServer());
    const provider = createRemoteMcpOAuthProvider({ server: baseServer(), storageArea: storage });
    await provider.saveTokens({ access_token: 'access-123', token_type: 'Bearer' });
    await provider.saveClientInformation?.({ client_id: 'client-abc' });

    await provider.invalidateCredentials?.('all');

    const reloaded = createRemoteMcpOAuthProvider({ server: baseServer(), storageArea: storage });
    await expect(reloaded.tokens()).resolves.toBeUndefined();
    await expect(reloaded.clientInformation()).resolves.toBeUndefined();
  });
});
