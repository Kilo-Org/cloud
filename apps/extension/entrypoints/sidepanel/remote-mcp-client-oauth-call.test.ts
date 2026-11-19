/* eslint-disable max-classes-per-file */
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { describe, expect, it, vi } from 'vitest';
import type { RemoteMcpServer } from '../../src/shared/remote-mcp';
import { loadRemoteMcpStore } from '../../src/shared/remote-mcp-storage';
import type { RemoteMcpStorageArea } from '../../src/shared/remote-mcp-storage';
import type { RemoteMcpToolRoute } from '../../src/shared/remote-mcp-tools';

interface CapturedAuthProvider {
  redirectToAuthorization(url: URL): Promise<void>;
}

const mocks = vi.hoisted(() => {
  const connect = vi.fn<() => Promise<void>>();
  const callTool = vi.fn<() => Promise<unknown>>();
  const close = vi.fn<() => Promise<void>>();
  const launchWebAuthFlow =
    vi.fn<(details: { interactive: boolean; url: string }) => Promise<string>>();
  const transport: { authProvider: CapturedAuthProvider | undefined } = {
    authProvider: undefined,
  };

  return { callTool, close, connect, launchWebAuthFlow, transport };
});

// eslint-disable-next-line vitest/prefer-import-in-mock, jest/no-untyped-mock-factory
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  class Client {
    connect = mocks.connect;
    callTool = mocks.callTool;
    close = mocks.close;
  }
  return { Client };
});

// eslint-disable-next-line vitest/prefer-import-in-mock, jest/no-untyped-mock-factory
vi.mock('#imports', () => ({
  browser: {
    identity: {
      getRedirectURL: () => 'https://abc.chromiumapp.org/remote-mcp',
      launchWebAuthFlow: mocks.launchWebAuthFlow,
    },
  },
}));

// eslint-disable-next-line vitest/prefer-import-in-mock, jest/no-untyped-mock-factory
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  class StreamableHTTPClientTransport {
    readonly url: URL;
    constructor(url: URL, options?: { readonly authProvider?: CapturedAuthProvider | undefined }) {
      this.url = url;
      mocks.transport.authProvider = options?.authProvider;
    }
  }
  return {
    StreamableHTTPClientTransport,
    StreamableHTTPError: class StreamableHTTPError extends Error {},
  };
});

// eslint-disable-next-line import/first
import { callRemoteMcpTool } from './remote-mcp-client';

// eslint-disable-next-line promise/prefer-await-to-then, @typescript-eslint/no-unsafe-type-assertion
const noopFetch = (() => Promise.resolve(new Response('{}'))) as unknown as typeof fetch;

const oauthServer: RemoteMcpServer = {
  allowInSafeMode: false,
  auth: { type: 'oauth' },
  cachedTools: [],
  displayName: 'OAuth Server',
  enabled: true,
  id: 'srv-1',
  slug: 'oauth-server',
  status: 'connected',
  url: 'https://mcp.example.com/',
};

const route: RemoteMcpToolRoute = {
  gatewayToolName: 'mcp_oauth-server_get_weather',
  remoteToolName: 'get_weather',
  serverId: 'srv-1',
  serverName: 'OAuth Server',
};

const createStorage = (servers: readonly RemoteMcpServer[]): RemoteMcpStorageArea => {
  let value: unknown = { servers };
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
  };
};

describe('remote MCP tool call against an OAuth server', () => {
  it('returns a needs-sign-in tool error without starting the browser flow', async () => {
    mocks.launchWebAuthFlow.mockReset();
    mocks.close.mockResolvedValue();
    mocks.callTool.mockReset();
    /* A 401 makes the SDK ask the provider to sign in; the tool path must refuse. */
    mocks.connect.mockImplementationOnce(async () => {
      await mocks.transport.authProvider?.redirectToAuthorization(
        new URL('https://auth.example.com/authorize')
      );
    });
    const storage = createStorage([oauthServer]);

    const result = await callRemoteMcpTool({
      arguments: {},
      fetch: noopFetch,
      route,
      server: oauthServer,
      storageArea: storage,
    });

    expect(mocks.launchWebAuthFlow).not.toHaveBeenCalled();
    expect(mocks.callTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('This server needs credentials.');

    const stored = await loadRemoteMcpStore(storage);
    expect(stored.servers.find(server => server.id === 'srv-1')?.status).toBe('needs_auth');
  });

  it('leaves an unrelated server status untouched when the store no longer has it', async () => {
    mocks.launchWebAuthFlow.mockReset();
    mocks.close.mockResolvedValue();
    mocks.connect.mockRejectedValueOnce(new UnauthorizedError('needs sign-in'));
    const otherServer: RemoteMcpServer = {
      ...oauthServer,
      displayName: 'Other Server',
      id: 'srv-2',
      slug: 'other-server',
      url: 'https://other.example.com/',
    };
    const storage = createStorage([otherServer]);

    const result = await callRemoteMcpTool({
      arguments: {},
      fetch: noopFetch,
      route,
      server: oauthServer,
      storageArea: storage,
    });

    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('This server needs credentials.');

    const stored = await loadRemoteMcpStore(storage);
    expect(stored.servers.map(server => [server.id, server.status])).toStrictEqual([
      ['srv-2', 'connected'],
    ]);
  });
});
