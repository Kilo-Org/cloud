import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type Tool } from '@kilocode/harness-sdk';
import {
  type RemoteMcpClientDeps,
  RemoteMcpError,
  type RemoteMcpResource,
  type RemoteMcpServer,
} from '@kilocode/harness-sdk/plugins/remote-mcp';

import { place, server, tool, viewTool } from './remote-mcp.test-helpers';
import { type StoredRemoteMcpServer } from './remote-mcp-store';

/**
 * The MCP Apps views a discovered tool can carry: what the transcript resolves
 * for one call, the document it reads, and the bridge it opens. The store is
 * faked so a server can be disabled and a discovery answered without a device.
 */

const world = vi.hoisted(() => ({
  servers: [] as StoredRemoteMcpServer[],
  calls: [] as { readonly server: RemoteMcpServer; readonly deps: RemoteMcpClientDeps }[],
  clients: [] as { readonly server: RemoteMcpServer; readonly deps: RemoteMcpClientDeps }[],
  apps: [] as {
    readonly server: RemoteMcpServer;
    readonly deps: RemoteMcpClientDeps;
    readonly options: { readonly tools: readonly string[] };
  }[],
  listeners: [] as (() => void)[],
  /** Never resolves: these tests answer the stored list as already read. */
  loaded: Promise.withResolvers<undefined>(),
}));

vi.mock('./remote-mcp-store', () => ({
  listRemoteMcpServers: () => world.servers,
  subscribeRemoteMcpServers: (listener: () => void) => {
    world.listeners.push(listener);
    return () => {
      world.listeners = world.listeners.filter(current => current !== listener);
    };
  },
  getRemoteMcpServersHasLoaded: () => true,
  whenRemoteMcpServersLoaded: async () => {
    await world.loaded.promise;
  },
}));

vi.mock('@/lib/auth/auth-epoch', () => ({ currentAuthEpoch: () => 0 }));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  getCommittedConnectivityStatus: () => 'online',
}));
vi.mock('./remote-mcp-oauth-provider', () => ({ remoteMcpOAuthProvider: () => ({}) }));

/** The discovery and the resource read, each answering from a mutable function. */
const answers = vi.hoisted(() => ({
  tools: () => Effect.succeed<readonly Tool[]>([]),
  resource: (): Effect.Effect<RemoteMcpResource, RemoteMcpError> =>
    Effect.succeed({
      uri: '',
      mimeType: undefined,
      text: undefined,
      blob: undefined,
      _meta: undefined,
    }),
}));

vi.mock('@kilocode/harness-sdk/plugins/remote-mcp', () => ({
  RemoteMcpError: class FakeRemoteMcpError extends Error {
    readonly kind: string;
    constructor(fields: { readonly kind: string; readonly cause: unknown }) {
      super(String(fields.cause));
      this.name = 'RemoteMcpError';
      this.kind = fields.kind;
    }
  },
  remoteMcpTools: (held: RemoteMcpServer, deps: RemoteMcpClientDeps) => {
    world.calls.push({ server: held, deps });
    return answers.tools();
  },
  remoteMcpClient: (held: RemoteMcpServer, deps: RemoteMcpClientDeps) => {
    world.clients.push({ server: held, deps });
    return { resource: () => answers.resource() };
  },
  remoteMcpApp: (
    held: RemoteMcpServer,
    deps: RemoteMcpClientDeps,
    options: { tools: readonly string[] }
  ) => {
    world.apps.push({ server: held, deps, options });
    return { marker: 'the bridge' };
  },
}));

// The module is loaded after its mocks exist, which a static import cannot
// guarantee: `vi.mock` is hoisted, and this module reads the store at load time.
const { ensureRemoteMcp, forgetRemoteMcp, openRemoteMcpApp, readRemoteMcpView } =
  await import('./remote-mcp');
const { mcpCallResultOf } = await import('./remote-mcp-call-results');
const { remoteServerView } = await import('./remote-mcp-surface');

const chart = viewTool('mcp_alpha_chart', 'chart', 'ui://alpha/chart.html');

/** One enabled server whose tool carries the chart view. */
async function discoveredWithChart() {
  world.servers = [server({ id: 'alpha' })];
  answers.tools = () => Effect.succeed([chart]);
  await ensureRemoteMcp(place);
  const view = remoteServerView('mcp_alpha_chart');
  if (view === undefined) {
    throw new Error('the tool carries no view');
  }
  return view;
}

/** The document the resource answers with. */
function answering(text: string, meta: Readonly<Record<string, unknown>> | undefined) {
  answers.resource = () =>
    Effect.succeed({
      uri: 'ui://alpha/chart.html',
      mimeType: 'text/html;profile=mcp-app',
      text,
      blob: undefined,
      _meta: meta,
    });
}

beforeEach(() => {
  world.servers = [];
  world.calls.length = 0;
  world.clients.length = 0;
  world.apps.length = 0;
  answers.tools = () => Effect.succeed([tool('mcp_alpha_read')]);
  answering('<html><head></head><body>chart</body></html>', undefined);
  forgetRemoteMcp();
});

describe('the view a tool carries', () => {
  it('is kept with the name the view calls the tool by', async () => {
    await discoveredWithChart();

    expect(remoteServerView('mcp_alpha_chart')).toEqual({
      serverId: 'alpha',
      serverToolName: 'chart',
      resourceUri: 'ui://alpha/chart.html',
    });
    expect(remoteServerView('mcp_alpha_read')).toBeUndefined();
  });

  it('is gone once the server that offers it is disabled', async () => {
    const alpha = server({ id: 'alpha' });
    world.servers = [alpha];
    answers.tools = () => Effect.succeed([chart]);
    await ensureRemoteMcp(place);
    expect(remoteServerView('mcp_alpha_chart')).toBeDefined();

    world.servers = [{ ...alpha, enabled: false }];
    for (const listener of world.listeners) {
      listener();
    }

    expect(remoteServerView('mcp_alpha_chart')).toBeUndefined();
  });
});

describe('the document a view is drawn from', () => {
  it('is read with the policy the resource declared', async () => {
    answering('<html><head></head><body>chart</body></html>', {
      ui: { csp: { connectDomains: ['https://api.example'] } },
    });
    const view = await discoveredWithChart();

    const read = await readRemoteMcpView(view);

    expect(read.kind).toBe('ready');
    const html = read.kind === 'ready' ? read.html : '';
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('connect-src https://api.example');
    // A read is not a call: it is bounded on its own and a row that cancels it
    // must not publish the server as failed.
    expect(world.clients[0]?.deps.onCallFailure).toBeUndefined();
    expect(world.clients[0]?.deps.timeoutMs).toBe(15_000);
  });

  it('is empty when the resource holds no document', async () => {
    answering('   ', undefined);
    const view = await discoveredWithChart();

    expect(await readRemoteMcpView(view)).toEqual({ kind: 'empty' });
  });

  it('is unavailable when the read fails', async () => {
    answers.resource = () =>
      Effect.fail(new RemoteMcpError({ serverId: 'alpha', kind: 'unreachable', cause: 'gone' }));
    const view = await discoveredWithChart();

    expect(await readRemoteMcpView(view)).toEqual({ kind: 'unavailable' });
  });
});

describe('the bridge a view calls back through', () => {
  it('is opened with the names the server calls its tools by', async () => {
    const view = await discoveredWithChart();

    expect(openRemoteMcpApp(view, {})).toEqual({ marker: 'the bridge' });
    expect(world.apps[0]?.options.tools).toEqual(['chart']);
    expect(world.apps[0]?.deps.onCallFailure).toBeDefined();
  });

  it('is not opened for a server that is no longer there', async () => {
    const view = await discoveredWithChart();
    world.servers = [];

    expect(openRemoteMcpApp(view, {})).toBeUndefined();
  });
});

describe('the whole answer of a call', () => {
  it('is kept for the row that draws it, and forgotten when the discovery is', async () => {
    world.servers = [server({ id: 'alpha' })];
    await ensureRemoteMcp(place);
    const answered = {
      tool: 'read',
      callId: 'call_1',
      content: [{ type: 'text' as const, text: 'chart drawn' }],
      structuredContent: { points: 3 },
    };

    world.calls[0]?.deps.onCallResult?.(answered);
    expect(mcpCallResultOf('call_1')).toEqual(answered);
    expect(mcpCallResultOf('call_2')).toBeUndefined();

    forgetRemoteMcp();
    expect(mcpCallResultOf('call_1')).toBeUndefined();
  });
});
