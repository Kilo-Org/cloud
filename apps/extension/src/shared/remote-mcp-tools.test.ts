import { describe, expect, it } from 'vitest';
import type { RemoteMcpServer } from './remote-mcp';
import {
  buildRemoteMcpToolDefinitions,
  capRemoteMcpToolResult,
  resolveRemoteMcpToolRoute,
} from './remote-mcp-tools';

const objectSchema = {
  additionalProperties: false,
  properties: {
    query: { type: 'string' },
  },
  required: ['query'],
  type: 'object',
};

const createServer = (overrides: Partial<RemoteMcpServer> = {}): RemoteMcpServer => ({
  allowInSafeMode: false,
  auth: { type: 'none' },
  cachedTools: [{ inputSchema: objectSchema, name: 'search_repos' }],
  displayName: 'GitHub',
  enabled: true,
  id: 'server-1',
  slug: 'github',
  status: 'connected',
  url: 'https://mcp.example.com',
  ...overrides,
});

describe('remote MCP tools', () => {
  it('maps remote tools to stable namespaced gateway tools and routes', () => {
    const result = buildRemoteMcpToolDefinitions({
      mode: 'dangerous',
      servers: [createServer()],
    });

    expect(result.tools).toStrictEqual([
      {
        function: {
          description: 'Run search_repos on GitHub.',
          name: 'mcp_github_search_repos',
          parameters: objectSchema,
        },
        type: 'function',
      },
    ]);
    expect(result.routes.get('mcp_github_search_repos')).toStrictEqual({
      gatewayToolName: 'mcp_github_search_repos',
      remoteToolName: 'search_repos',
      serverId: 'server-1',
      serverName: 'GitHub',
    });
  });

  it('skips source names that cannot produce valid gateway names', () => {
    const result = buildRemoteMcpToolDefinitions({
      mode: 'dangerous',
      servers: [
        createServer({ cachedTools: [{ inputSchema: objectSchema, name: 'search repos' }] }),
      ],
    });

    expect(result.tools).toStrictEqual([]);
    expect(result.routes.size).toBe(0);
  });

  it('skips duplicate mapped names', () => {
    const result = buildRemoteMcpToolDefinitions({
      mode: 'dangerous',
      servers: [
        createServer({ id: 'server-1', slug: 'github' }),
        createServer({ id: 'server-2', slug: 'github' }),
      ],
    });

    expect(result.tools).toStrictEqual([]);
    expect(result.routes.size).toBe(0);
    expect(result.warning).toBeUndefined();
  });

  it('skips non-object input schemas', () => {
    const result = buildRemoteMcpToolDefinitions({
      mode: 'dangerous',
      servers: [
        createServer({
          cachedTools: [
            {
              inputSchema: { type: 'string' },
              name: 'search_repos',
            },
          ],
        }),
      ],
    });

    expect(result.tools).toStrictEqual([]);
    expect(result.routes.size).toBe(0);
  });

  it('exposes only safe-mode allowed servers in safe mode', () => {
    const result = buildRemoteMcpToolDefinitions({
      mode: 'safe',
      servers: [
        createServer({ allowInSafeMode: false, id: 'server-1', slug: 'github' }),
        createServer({ allowInSafeMode: true, id: 'server-2', slug: 'linear' }),
      ],
    });

    expect(result.tools.map(tool => tool.function.name)).toStrictEqual(['mcp_linear_search_repos']);
  });

  it('exposes enabled connected servers in dangerous mode', () => {
    const result = buildRemoteMcpToolDefinitions({
      mode: 'dangerous',
      servers: [
        createServer({ enabled: false, id: 'disabled', slug: 'disabled' }),
        createServer({ id: 'needs-auth', slug: 'needs-auth', status: 'needs_auth' }),
        createServer({ id: 'unavailable', slug: 'unavailable', status: 'unavailable' }),
        createServer({ id: 'untested', slug: 'untested', status: 'untested' }),
        createServer({ id: 'connected', slug: 'connected' }),
      ],
    });

    expect(result.tools.map(tool => tool.function.name)).toStrictEqual([
      'mcp_connected_search_repos',
    ]);
  });

  it('returns no tools when mode-allowed remote MCP tools exceed the limit', () => {
    const cachedTools = Array.from({ length: 129 }, (_unused, index) => ({
      inputSchema: objectSchema,
      name: `tool_${index}`,
    }));

    const result = buildRemoteMcpToolDefinitions({
      mode: 'dangerous',
      servers: [createServer({ cachedTools })],
    });

    expect(result.tools).toStrictEqual([]);
    expect(result.routes.size).toBe(0);
    expect(result.warning).toContain('the limit is 128');
  });

  it('returns a clear stale-route error for unavailable tool calls', () => {
    const result = buildRemoteMcpToolDefinitions({
      mode: 'dangerous',
      servers: [createServer()],
    });

    expect(resolveRemoteMcpToolRoute(result.routes, 'mcp_github_search_repos')).toStrictEqual({
      ok: true,
      route: {
        gatewayToolName: 'mcp_github_search_repos',
        remoteToolName: 'search_repos',
        serverId: 'server-1',
        serverName: 'GitHub',
      },
    });
    expect(resolveRemoteMcpToolRoute(result.routes, 'mcp_github_stale')).toStrictEqual({
      error: 'Remote MCP tool mcp_github_stale is no longer available.',
      ok: false,
    });
  });

  it('caps oversized JSON tool results at 64 KB', () => {
    const result = capRemoteMcpToolResult({ value: 'x'.repeat(70 * 1024) });

    expect(result).toStrictEqual({
      truncated: true,
      value: JSON.stringify({ value: 'x'.repeat(70 * 1024) }).slice(0, 64 * 1024),
    });
  });
});
