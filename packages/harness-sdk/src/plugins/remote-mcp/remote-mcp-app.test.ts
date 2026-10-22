import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/ext-apps/app-bridge';
import { describe, expect, it } from 'vitest';
import { remoteMcpApp, type RemoteMcpApp, type RemoteMcpAppTransport } from './index.js';
import { chartApp, deps, serve, serverFor, token } from './remote-mcp-fixture.js';

/**
 * The host half of an MCP Apps view, over a real protocol server. The view on
 * the other end is written here: it sends the bridge's own JSON-RPC messages
 * and reads the answers, which is what a sandboxed WebView will do.
 */

/** One message on the bridge, in the shape both ends exchange. */
interface Wire {
  readonly jsonrpc: '2.0';
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

const isWire = (held: unknown): held is Wire =>
  typeof held === 'object' && held !== null && 'jsonrpc' in held;

/** Resolves the request whose reply this is, if the test is waiting on one. */
const recording = (sent: Wire[], waiting: Map<number, (message: Wire) => void>) => (wire: Wire) => {
  sent.push(wire);
  if (wire.id === undefined) {
    return;
  }
  const resolve = waiting.get(wire.id);
  if (resolve !== undefined) {
    waiting.delete(wire.id);
    resolve(wire);
  }
};

/** The bridge's far end, as one view drives it. */
interface Channel {
  readonly transport: RemoteMcpAppTransport;
  readonly sent: Wire[];
  request(id: number, method: string, params?: unknown): Promise<Wire>;
  notify(method: string, params?: unknown): void;
  lastOf(method: string): Wire | undefined;
}

/** The bridge's far end: records what the host sends and answers what is asked. */
const channel = (view: { app?: RemoteMcpApp }): Channel => {
  const sent: Wire[] = [];
  const waiting = new Map<number, (message: Wire) => void>();
  const record = recording(sent, waiting);
  const transport: RemoteMcpAppTransport = {
    send: message => {
      const held: unknown = JSON.parse(message);
      if (isWire(held)) {
        record(held);
      }
    },
  };
  return {
    transport,
    sent,
    request: (id, method, params) => {
      const answered = Promise.withResolvers<Wire>();
      waiting.set(id, answered.resolve);
      view.app?.receive(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      return answered.promise;
    },
    notify: (method, params) => {
      view.app?.receive(JSON.stringify({ jsonrpc: '2.0', method, params }));
    },
    lastOf: method => sent.findLast(message => message.method === method),
  };
};

/** The handshake one view opens with, as the protocol defines it. */
const initialize = (bridge: Channel) =>
  bridge.request(1, 'ui/initialize', {
    appInfo: { name: 'The view', version: '1.0.0' },
    appCapabilities: {},
    protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
  });

/** What one view reports about itself, as promises a test can wait on. */
const observing = (app: RemoteMcpApp) => {
  const sizes: { height?: number | undefined }[] = [];
  const initialized = Promise.withResolvers<void>();
  const sized = Promise.withResolvers<void>();
  app.onInitialized(initialized.resolve);
  app.onSizeChanged(size => {
    sizes.push(size);
    sized.resolve();
  });
  return { sizes, initialized, sized };
};

/** One view's bridge, connected to a server and ready for the handshake. */
const connected = async (
  options: {
    context?: { theme?: 'light' | 'dark'; locale?: string };
    openLink?: (uri: string) => void;
  } = {}
) => {
  const served = await serve(chartApp);
  const app = remoteMcpApp(serverFor('work', served.url, token), deps(), {
    tools: ['draw-chart'],
    ...options,
  });
  const bridge = channel({ app });
  await app.connect(bridge.transport);
  return { served, app, bridge };
};

/** The same, once the view has initialized and the host may hand it the call. */
const opened = async () => {
  const { served, app, bridge } = await connected();
  const handshake = await initialize(bridge);
  bridge.notify('ui/notifications/initialized', {});
  return { served, app, bridge, handshake };
};

describe('the handshake a view opens with', () => {
  it('is answered with the host this is, and no feature it does not offer', async () => {
    const { bridge, handshake } = await opened();
    expect(handshake.error).toBeUndefined();
    expect(handshake.result).toMatchObject({
      hostInfo: { name: 'Kilo' },
      hostCapabilities: { openLinks: {}, serverTools: {}, logging: {} },
      hostContext: {
        displayMode: 'inline',
        platform: 'mobile',
        deviceCapabilities: { touch: true, hover: false },
      },
    });
    const refused = await bridge.request(2, 'ui/message', { content: [] });
    expect(refused.error?.code).toBeDefined();
  });

  it('is told the person’s theme, language and box', async () => {
    const { bridge } = await connected({ context: { theme: 'dark', locale: 'de-DE' } });
    const handshake = await initialize(bridge);
    expect(handshake.result).toMatchObject({
      hostContext: { theme: 'dark', locale: 'de-DE' },
    });
  });
});

describe('the lifecycle a view reports', () => {
  it('says when it has initialized, and the size it asks for', async () => {
    const { app, bridge } = await connected();
    const { sizes, initialized, sized } = observing(app);
    await initialize(bridge);
    bridge.notify('ui/notifications/initialized', {});
    await initialized.promise;
    bridge.notify('ui/notifications/size-changed', { width: 360, height: 210 });
    await sized.promise;
    expect(sizes).toEqual([{ width: 360, height: 210 }]);
  });

  it('drops what the view sends before the bridge is connected', () => {
    const served = { url: 'http://127.0.0.1:1/mcp', seen: { authorization: [] } };
    const app = remoteMcpApp(serverFor('work', served.url, token), deps(), {
      tools: ['draw-chart'],
    });
    const bridge = channel({ app });
    expect(() => {
      bridge.notify('ui/notifications/size-changed', { height: 999 });
    }).not.toThrow();
    expect(bridge.sent).toEqual([]);
  });
});

describe('the call a view renders', () => {
  it('receives the arguments, then the answer whole', async () => {
    const { app, bridge } = await opened();
    await app.input({ city: 'Oslo' });
    await app.result({
      content: [{ type: 'text', text: 'chart drawn' }],
      structuredContent: { points: 3 },
    });
    expect(bridge.lastOf('ui/notifications/tool-input')?.params).toEqual({
      arguments: { city: 'Oslo' },
    });
    expect(bridge.lastOf('ui/notifications/tool-result')?.params).toMatchObject({
      content: [{ type: 'text', text: 'chart drawn' }],
      structuredContent: { points: 3 },
    });
  });
});

describe('a tool the view calls back', () => {
  it('reaches the same server the view came from, and answers with its result', async () => {
    const { served, bridge } = await opened();
    const answer = await bridge.request(2, 'tools/call', {
      name: 'draw-chart',
      arguments: {},
    });
    expect(answer.result).toMatchObject({
      content: [{ type: 'text', text: 'chart drawn' }],
      structuredContent: { points: 3 },
    });
    // It went over the wire: the fixture saw a credentialed request.
    expect(served.seen.authorization.length).toBeGreaterThan(1);
  });

  it('is refused when it is not a tool of this server', async () => {
    const { served, bridge } = await opened();
    const before = served.seen.authorization.length;
    const answer = await bridge.request(2, 'tools/call', {
      name: 'read-file',
      arguments: { path: '/etc/passwd' },
    });
    expect(answer.error?.message).toContain('read-file');
    expect(served.seen.authorization.length).toBe(before);
  });
});

describe('a call the server refuses for the view', () => {
  it('is answered with the words the model would read, flagged as an error', async () => {
    const refusing = await serve({
      list: [
        {
          name: 'draw-chart',
          inputSchema: { type: 'object', properties: {} },
          _meta: { ui: { resourceUri: 'ui://work/chart.html' } },
        },
      ],
      call: () => ({ content: [{ type: 'text', text: 'refused by the server' }], isError: true }),
    });
    const app = remoteMcpApp(serverFor('work', refusing.url, token), deps(), {
      tools: ['draw-chart'],
    });
    const bridge = channel({ app });
    await app.connect(bridge.transport);
    await initialize(bridge);
    const answer = await bridge.request(2, 'tools/call', { name: 'draw-chart', arguments: {} });
    expect(answer.result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'refused by the server' }],
    });
  });
});

describe('an open link the view asks for', () => {
  it('reaches the host and is answered, so the view does not hang', async () => {
    const openedLinks: string[] = [];
    const { bridge } = await connected({ openLink: uri => openedLinks.push(uri) });
    await initialize(bridge);
    const answer = await bridge.request(2, 'ui/open-link', { url: 'https://example.test/x' });
    expect(answer.error).toBeUndefined();
    expect(openedLinks).toEqual(['https://example.test/x']);
  });
});
