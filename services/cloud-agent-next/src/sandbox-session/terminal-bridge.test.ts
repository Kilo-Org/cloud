import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSessionMetadata } from '../persistence/session-metadata.js';
import type {
  ResponseFrame,
  SessionTerminalConnectPayload,
} from '../shared/sandbox-control-protocol.js';
import { createSandboxTerminalBridge, type SandboxTerminalRecord } from './terminal-bridge.js';

const SESSION_ID = 'workspace_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WRAPPER_INSTANCE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PTY_ID = 'pty_test';

class FakeWebSocket {
  readyState = 0;
  tags: string[] = [];
  private attachment: unknown = null;

  readonly send = vi.fn<(message: string | ArrayBuffer) => void>();
  readonly close = vi.fn<(code: number, reason: string) => void>(() => {
    this.readyState = 2;
  });
  readonly serializeAttachment = vi.fn<(value: unknown) => void>(value => {
    this.attachment = structuredClone(value);
  });
  readonly deserializeAttachment = vi.fn<() => unknown>(() => this.attachment);
}

class FakeWebSocketPair {
  readonly 0 = new FakeWebSocket();
  readonly 1 = new FakeWebSocket();
}

class FakeResponse {
  readonly status: number;
  readonly webSocket?: WebSocket;

  constructor(_body: unknown, init?: ResponseInit & { webSocket?: WebSocket }) {
    this.status = init?.status ?? 200;
    this.webSocket = init?.webSocket;
  }
}

function asWebSocket(socket: FakeWebSocket): WebSocket {
  return socket as unknown as WebSocket;
}

function response(): ResponseFrame {
  return {
    type: 'response',
    requestId: 'request_terminal',
    ok: true,
    result: { connected: true },
  };
}

function request(pathname: string, authorization?: string): Request {
  const headers = new Headers({ Upgrade: 'websocket' });
  if (authorization) headers.set('Authorization', `Bearer ${authorization}`);
  return new Request(`http://session.test${pathname}?ptyId=${PTY_ID}`, { headers });
}

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>(complete => {
    resolve = complete;
  });
  return {
    promise,
    resolve(value: T) {
      if (!resolve) throw new Error('Missing deferred resolver');
      resolve(value);
    },
  };
}

function createHarness() {
  const metadata = parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: { sessionId: SESSION_ID, userId: 'user_test' },
    auth: { kiloSessionId: 'kilo_test' },
    workspace: { sandboxId: 'ses-abcdef', workspacePath: '/workspace/user_test' },
    lifecycle: { version: 1, timestamp: 1 },
  });
  let record: SandboxTerminalRecord = {
    ptyId: PTY_ID,
    ownerId: 'user_test',
    sessionId: SESSION_ID,
    kiloSessionId: 'kilo_test',
    directory: '/workspace/user_test',
    sandboxId: 'ses-abcdef',
    wrapperInstanceId: WRAPPER_INSTANCE_ID,
    state: 'running',
  };
  const sockets: FakeWebSocket[] = [];
  const activities: Promise<unknown>[] = [];
  const state = {
    id: { name: `user_test:${SESSION_ID}` },
    acceptWebSocket: vi.fn((socket: WebSocket, tags: string[] = []) => {
      const accepted = socket as unknown as FakeWebSocket;
      accepted.tags = tags;
      accepted.readyState = 1;
      sockets.push(accepted);
    }),
    getWebSockets: vi.fn((tag?: string) =>
      sockets.filter(socket => tag === undefined || socket.tags.includes(tag)).map(asWebSocket)
    ),
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      activities.push(promise);
    }),
  } as unknown as DurableObjectState;
  const getMetadata = vi.fn(async () => metadata);
  const getTerminal = vi.fn(async (ptyId: string) => (ptyId === PTY_ID ? record : undefined));
  const reportActivity = vi.fn(async () => undefined);
  const markEnded = vi.fn(async () => {
    record = { ...record, state: 'ended' };
  });
  const requestConnect = vi.fn(
    async (_record: SandboxTerminalRecord, payload: SessionTerminalConnectPayload) => {
      const upgrade = await bridge.handleWrapperUpgrade(
        request('/terminal/wrapper', payload.capability)
      );
      expect(upgrade.status).toBe(101);
      return response();
    }
  );

  const bridge = createSandboxTerminalBridge({
    state,
    getMetadata,
    getTerminal,
    requestConnect,
    reportActivity,
    markEnded,
  });

  return {
    bridge,
    sockets,
    activities,
    state,
    getMetadata,
    getTerminal,
    requestConnect,
    reportActivity,
    markEnded,
    setRecord(value: SandboxTerminalRecord) {
      record = value;
    },
    get record() {
      return record;
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('WebSocketPair', FakeWebSocketPair);
  vi.stubGlobal('Response', FakeResponse);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sandbox terminal bridge', () => {
  it('pairs hibernation sockets, consumes the capability, and forwards native frames', async () => {
    const harness = createHarness();
    const upgraded = await harness.bridge.handleBrowserUpgrade(request('/terminal/browser'));
    expect(upgraded.status).toBe(101);
    expect(harness.sockets).toHaveLength(2);

    const browser = harness.sockets[0];
    const wrapper = harness.sockets[1];
    if (!browser || !wrapper) throw new Error('Missing paired sockets');
    expect(browser.tags).toEqual(['terminal', `terminal:browser:${PTY_ID}`]);
    expect(wrapper.tags).toEqual(['terminal', `terminal:wrapper:${PTY_ID}`]);
    expect(browser.deserializeAttachment()).not.toHaveProperty('capabilityHash');
    expect(wrapper.deserializeAttachment()).not.toHaveProperty('capabilityHash');

    await harness.bridge.handleMessage(asWebSocket(browser), 'ping');
    await harness.bridge.handleMessage(asWebSocket(browser), 'more input');
    expect(wrapper.send).toHaveBeenCalledWith('ping');
    expect(wrapper.send).toHaveBeenCalledWith('more input');

    const binary = new Uint8Array([0, 127, 255]).buffer;
    await harness.bridge.handleMessage(asWebSocket(wrapper), binary);
    expect(browser.send).toHaveBeenCalledWith(binary);

    await Promise.all(harness.activities);
    expect(harness.reportActivity).toHaveBeenCalledTimes(2);
  });

  it('allows exactly one concurrent redemption of a pending capability', async () => {
    const harness = createHarness();
    harness.requestConnect.mockImplementation(async (_record, payload) => {
      const upgrades = await Promise.all([
        harness.bridge.handleWrapperUpgrade(request('/terminal/wrapper', payload.capability)),
        harness.bridge.handleWrapperUpgrade(request('/terminal/wrapper', payload.capability)),
      ]);
      expect(upgrades.map(upgrade => upgrade.status).sort()).toEqual([101, 401]);
      return response();
    });

    await expect(
      harness.bridge.handleBrowserUpgrade(request('/terminal/browser'))
    ).resolves.toMatchObject({ status: 101 });
    expect(harness.sockets).toHaveLength(2);
  });

  it('rejects expired producer capabilities without accepting a wrapper socket', async () => {
    const harness = createHarness();
    harness.requestConnect.mockImplementation(async (_record, payload) => {
      const browser = harness.sockets[0];
      if (!browser) throw new Error('Missing pending browser');
      const attachment = browser.deserializeAttachment();
      if (typeof attachment !== 'object' || attachment === null) {
        throw new Error('Missing pending browser attachment');
      }
      browser.serializeAttachment({ ...attachment, capabilityExpiresAt: Date.now() - 1 });
      await expect(
        harness.bridge.handleWrapperUpgrade(request('/terminal/wrapper', payload.capability))
      ).resolves.toMatchObject({ status: 401 });
      return response();
    });

    await expect(
      harness.bridge.handleBrowserUpgrade(request('/terminal/browser'))
    ).resolves.toMatchObject({ status: 409 });
    expect(harness.sockets).toHaveLength(1);
  });

  it('revokes superseded capabilities before closing sockets that remain discoverable', async () => {
    const harness = createHarness();
    const firstStarted = deferred<SessionTerminalConnectPayload>();
    const releaseFirst = deferred<ResponseFrame>();
    let calls = 0;
    harness.requestConnect.mockImplementation(async (_record, payload) => {
      calls += 1;
      if (calls === 1) {
        firstStarted.resolve(payload);
        return releaseFirst.promise;
      }
      const upgraded = await harness.bridge.handleWrapperUpgrade(
        request('/terminal/wrapper', payload.capability)
      );
      expect(upgraded.status).toBe(101);
      return response();
    });

    const first = harness.bridge.handleBrowserUpgrade(request('/terminal/browser'));
    const pending = await firstStarted.promise;
    const oldBrowser = harness.sockets[0];
    if (!oldBrowser) throw new Error('Missing pending browser');
    expect(oldBrowser.deserializeAttachment()).toHaveProperty('capabilityHash');

    const second = await harness.bridge.handleBrowserUpgrade(request('/terminal/browser'));
    expect(second.status).toBe(101);
    expect(oldBrowser.readyState).toBe(2);
    expect(oldBrowser.deserializeAttachment()).not.toHaveProperty('capabilityHash');
    await expect(
      harness.bridge.handleWrapperUpgrade(request('/terminal/wrapper', pending.capability))
    ).resolves.toMatchObject({ status: 401 });

    releaseFirst.resolve(response());
    await expect(first).resolves.toMatchObject({ status: 409 });
    const currentBrowser = harness.sockets.find(
      socket => socket.readyState === 1 && socket.tags.includes(`terminal:browser:${PTY_ID}`)
    );
    expect(currentBrowser).toBeDefined();
  });

  it('does not let old close events terminate replacement generations', async () => {
    const harness = createHarness();
    await harness.bridge.handleBrowserUpgrade(request('/terminal/browser'));
    const oldBrowser = harness.sockets[0];
    const oldWrapper = harness.sockets[1];
    if (!oldBrowser || !oldWrapper) throw new Error('Missing original socket pair');

    await harness.bridge.handleBrowserUpgrade(request('/terminal/browser'));
    const browser = harness.sockets[2];
    const wrapper = harness.sockets[3];
    if (!browser || !wrapper) throw new Error('Missing replacement socket pair');

    await harness.bridge.handleMessage(asWebSocket(oldWrapper), 'stale output');
    await harness.bridge.handleClose(asWebSocket(oldBrowser), 1000, 'stale', true);
    await harness.bridge.handleClose(asWebSocket(oldWrapper), 1000, 'stale', true);
    expect(browser.send).not.toHaveBeenCalled();
    expect(browser.readyState).toBe(1);
    expect(wrapper.readyState).toBe(1);
    expect(harness.markEnded).not.toHaveBeenCalled();
  });

  it('acknowledges a browser-initiated close without ending its running PTY', async () => {
    const harness = createHarness();
    await harness.bridge.handleBrowserUpgrade(request('/terminal/browser'));
    const browser = harness.sockets[0];
    const wrapper = harness.sockets[1];
    if (!browser || !wrapper) throw new Error('Missing socket pair');

    browser.readyState = 2;
    await harness.bridge.handleClose(asWebSocket(browser), 1000, 'verification reconnect', true);

    expect(browser.close).toHaveBeenCalledWith(1000, 'verification reconnect');
    expect(wrapper.close).toHaveBeenCalledWith(1000, 'Browser disconnected');
    expect(harness.markEnded).not.toHaveBeenCalled();
    expect(harness.record.state).toBe('running');
    await expect(
      harness.bridge.handleBrowserUpgrade(request('/terminal/browser'))
    ).resolves.toMatchObject({ status: 101 });
  });

  it('ends a PTY only after its current wrapper closes normally', async () => {
    const harness = createHarness();
    await harness.bridge.handleBrowserUpgrade(request('/terminal/browser'));
    const browser = harness.sockets[0];
    const wrapper = harness.sockets[1];
    if (!browser || !wrapper) throw new Error('Missing socket pair');

    wrapper.readyState = 2;
    await harness.bridge.handleMessage(asWebSocket(wrapper), 'final output');
    expect(browser.send).toHaveBeenCalledWith('final output');
    await harness.bridge.handleClose(asWebSocket(wrapper), 1000, 'process exited', true);
    expect(harness.markEnded).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledWith(1000, 'PTY session ended');

    const ended = await harness.bridge.handleBrowserUpgrade(request('/terminal/browser'));
    expect(ended.status).toBe(101);
    expect(harness.sockets[2]?.close).toHaveBeenCalledWith(1000, 'PTY session ended');
  });

  it('closes oversized frames and normalizes reserved codes and oversized reasons', async () => {
    const harness = createHarness();
    await harness.bridge.handleBrowserUpgrade(request('/terminal/browser'));
    const browser = harness.sockets[0];
    const wrapper = harness.sockets[1];
    if (!browser || !wrapper) throw new Error('Missing socket pair');

    await harness.bridge.handleMessage(asWebSocket(browser), 'x'.repeat(256 * 1024 + 1));
    expect(browser.close).toHaveBeenCalledWith(1009, 'Terminal frame too large');
    expect(wrapper.close).toHaveBeenCalledWith(1009, 'Terminal frame too large');

    await harness.bridge.handleBrowserUpgrade(request('/terminal/browser'));
    const replacement = harness.sockets[2];
    if (!replacement) throw new Error('Missing replacement browser');
    harness.bridge.closeTerminal(PTY_ID, 1006, 'é'.repeat(100));
    const call = replacement.close.mock.calls[0];
    expect(call?.[0]).toBe(1011);
    expect(new TextEncoder().encode(call?.[1] ?? '').byteLength).toBeLessThanOrEqual(123);
  });

  it('rejects mismatched owner, root session, directory, and sandbox metadata', async () => {
    for (const field of ['ownerId', 'kiloSessionId', 'directory', 'sandboxId'] as const) {
      const harness = createHarness();
      harness.setRecord({ ...harness.record, [field]: 'mismatched' });
      await expect(
        harness.bridge.handleBrowserUpgrade(request('/terminal/browser'))
      ).resolves.toMatchObject({ status: 403 });
      expect(harness.requestConnect).not.toHaveBeenCalled();
    }
  });
});
