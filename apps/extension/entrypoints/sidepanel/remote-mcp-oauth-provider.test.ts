import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteMcpServer } from '../../src/shared/remote-mcp';
import {
  REMOTE_MCP_STORAGE_KEY,
  type RemoteMcpStorageArea,
} from '../../src/shared/remote-mcp-storage';

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

beforeEach(() => {
  mocks.getRedirectURL.mockReset();
  mocks.launchWebAuthFlow.mockReset();
  mocks.getRedirectURL.mockReturnValue('https://abc.chromiumapp.org/remote-mcp');
});

describe('createRemoteMcpOAuthProvider', () => {
  it('reports the browser redirect URL and public client metadata', () => {
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
    const storage = createStorage(baseServer());
    const provider = createRemoteMcpOAuthProvider({ server: baseServer(), storageArea: storage });

    await provider.saveClientInformation?.({ client_id: 'client-abc' });

    const reloaded = createRemoteMcpOAuthProvider({
      server: baseServer(),
      storageArea: storage,
    });
    expect(await reloaded.clientInformation()).toMatchObject({ client_id: 'client-abc' });
  });

  it('persists tokens and reads them back', async () => {
    const storage = createStorage(baseServer());
    const provider = createRemoteMcpOAuthProvider({ server: baseServer(), storageArea: storage });

    await provider.saveTokens({ access_token: 'access-123', token_type: 'Bearer' });

    const reloaded = createRemoteMcpOAuthProvider({
      server: baseServer(),
      storageArea: storage,
    });
    expect(await reloaded.tokens()).toMatchObject({ access_token: 'access-123' });
  });

  it('persists the code verifier and reads it back', async () => {
    const storage = createStorage(baseServer());
    const provider = createRemoteMcpOAuthProvider({ server: baseServer(), storageArea: storage });

    await provider.saveCodeVerifier('verifier-xyz');

    const reloaded = createRemoteMcpOAuthProvider({
      server: baseServer(),
      storageArea: storage,
    });
    expect(await reloaded.codeVerifier()).toBe('verifier-xyz');
  });

  it('launches the web auth flow with the authorization URL', async () => {
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
    const storage = createStorage(baseServer());
    const provider = createRemoteMcpOAuthProvider({ server: baseServer(), storageArea: storage });
    await provider.saveTokens({ access_token: 'access-123', token_type: 'Bearer' });
    await provider.saveClientInformation?.({ client_id: 'client-abc' });

    await provider.invalidateCredentials?.('all');

    const reloaded = createRemoteMcpOAuthProvider({ server: baseServer(), storageArea: storage });
    expect(await reloaded.tokens()).toBeUndefined();
    expect(await reloaded.clientInformation()).toBeUndefined();
  });
});
