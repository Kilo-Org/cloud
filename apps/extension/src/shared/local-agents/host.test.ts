/* eslint-disable import/max-dependencies, max-expects, max-lines, promise/prefer-await-to-callbacks, vitest/no-conditional-in-test, typescript-eslint/consistent-type-definitions -- one integration harness asserts each protocol step of the flow and supplies the storage watcher fakes */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { base64UrlEncode, computeHubMac, decodePairingKey } from './encoding';
import { LOCAL_AGENT_ENDPOINTS_STORAGE_KEY } from './endpoints';
import type { LoopbackSocketConnect, LoopbackSocketHandlers } from './loopback-transport';
import { LOCAL_AGENT_CONTROLLERS_STORAGE_KEY, loadLocalAgentConnectedAgents } from './registry';
import { LOCAL_AGENT_SETTINGS_STORAGE_KEY } from './settings';
import type {
  LocalAgentStorageArea,
  LocalAgentStorageKey,
  LocalAgentStorageWatch,
} from './storage';
import { loadLocalAgentStatus } from './status';
import { startLocalAgentsHost } from './host';
import { LOCAL_AGENTS_COMMAND_MESSAGE } from './commands';

const HUB_ID = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const WS = 'ws://127.0.0.1:47917/__kilo_browser';
const EXTENSION_ID = 'kilo-test-extension-id';
const CONTROLLER_ID = '11111111-2222-4333-8444-555555555555';
const PAIRING_URL = `http://127.0.0.1:47917/__kilo_browser_pair#v=1&hub=${HUB_ID}&k=${KEY}&ws=${encodeURIComponent(WS)}`;
const NEW_KEY = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8';
const NEW_WS = 'ws://127.0.0.1:48100/__kilo_browser';
const REPAIRING_URL = `http://127.0.0.1:48100/__kilo_browser_pair#v=1&hub=${HUB_ID}&k=${NEW_KEY}&ws=${encodeURIComponent(NEW_WS)}`;

const recordSchema = z.record(z.string(), z.unknown());
const stringRecordSchema = z.record(z.string(), z.string());
const sessionResultSchema = z.object({ sessionHandle: z.string() });

const sessionHandleOf = (response: Record<string, unknown> | undefined) => {
  const parsed = sessionResultSchema.safeParse(response?.['result']);

  return parsed.success ? parsed.data.sessionHandle : undefined;
};

type FakeSocket = {
  closed: number;
  handlers: LoopbackSocketHandlers;
  sent: string[];
  url: string;
};

type MemoryStorage = LocalAgentStorageArea & {
  items: Map<string, unknown>;
  notify(key: string): void;
  watch: LocalAgentStorageWatch;
};

const createMemoryStorage = (): MemoryStorage => {
  const items = new Map<string, unknown>();
  const watchers = new Map<string, Set<() => void>>();
  const watch: LocalAgentStorageWatch = (key, callback) => {
    const set = watchers.get(key) ?? new Set<() => void>();
    set.add(callback);
    watchers.set(key, set);

    return () => {
      set.delete(callback);
    };
  };

  return {
    getItem: (key: string) => items.get(key) ?? null,
    items,
    notify: (key: string) => {
      for (const callback of watchers.get(key) ?? []) {
        callback();
      }
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
    setItem: (key: string, value: unknown) => {
      items.set(key, value);
    },
    watch,
  };
};

const framesOf = (sent: string[]) => sent.map(text => recordSchema.parse(JSON.parse(text)));

const sentWithType = (sent: string[], type: string) =>
  framesOf(sent).find(frame => frame['type'] === type);

const messageOf = (frame: Record<string, unknown> | undefined) => {
  const parsed = recordSchema.safeParse(frame?.['message']);

  return parsed.success ? parsed.data : undefined;
};

const rpcWith = (sent: string[], key: 'id' | 'method', value: string | number) =>
  framesOf(sent).find(frame => frame['type'] === 'rpc' && messageOf(frame)?.[key] === value);

const nonce = (fill: number) => base64UrlEncode(new Uint8Array(16).fill(fill));

const createHarness = () => {
  const storage = createMemoryStorage();
  const sockets: FakeSocket[] = [];
  const listeners: {
    alarm?: (alarm: { name: string }) => void;
    command?: (command: string) => void;
    message?: (
      message: unknown,
      sender: unknown,
      sendResponse: (response: { ok: boolean }) => void
    ) => boolean | undefined;
    tabUpdated?: (
      tabId: number,
      changeInfo: { url?: string },
      tab: { openerTabId?: number; url?: string }
    ) => void;
  } = {};
  const removeTab = vi.fn((): Promise<void> => Promise.resolve());
  const createSocket: LoopbackSocketConnect = (url, handlers) => {
    const socket: FakeSocket = { closed: 0, handlers, sent: [], url };
    sockets.push(socket);

    return {
      close: () => {
        socket.closed += 1;
      },
      sendText: (text: string) => {
        socket.sent.push(text);
      },
    };
  };

  const alarms = {
    clear: vi.fn((): Promise<boolean> => Promise.resolve(true)),
    create: vi.fn(),
    onAlarm: {
      addListener: (listener: (alarm: { name: string }) => void) => {
        listeners.alarm = listener;
      },
    },
  };
  const commands = {
    onCommand: {
      addListener: (listener: (command: string) => void) => {
        listeners.command = listener;
      },
    },
  };
  const runtime = {
    id: EXTENSION_ID,
    onMessage: {
      addListener: (
        listener: (
          message: unknown,
          sender: unknown,
          sendResponse: (response: { ok: boolean }) => void
        ) => boolean | undefined
      ) => {
        listeners.message = listener;
      },
    },
  };
  const tabs = {
    onUpdated: {
      addListener: (
        listener: (
          tabId: number,
          changeInfo: { url?: string },
          tab: { openerTabId?: number; url?: string }
        ) => void
      ) => {
        listeners.tabUpdated = listener;
      },
    },
    remove: removeTab,
  };
  const hostOptions = {
    availability: {
      hasDebugger: false,
      hasScripting: true,
      hasTabGroups: false,
      hasWebRequest: false,
    },
    createSocket,
    now: () => 1000,
    storage,
    timers: {
      clearTimeout: (_handle: number) => {
        /* The harness never lets a retry timer fire. */
      },
      setTimeout: () => 0,
    },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0.0.0 Safari/537.36',
    watch: storage.watch,
  };

  return {
    alarms,
    commands,
    hostOptions,
    listeners,
    removeTab,
    runtime,
    sockets,
    storage,
    tabs,
  };
};

const startHost = (harness: ReturnType<typeof createHarness>) =>
  startLocalAgentsHost({
    ...harness.hostOptions,
    alarms: harness.alarms,
    commands: harness.commands,
    runtime: harness.runtime,
    tabs: harness.tabs,
  });

const seedEnabledWithEndpoint = (storage: MemoryStorage) => {
  storage.items.set(LOCAL_AGENT_SETTINGS_STORAGE_KEY, { enabled: true });
  storage.items.set(LOCAL_AGENT_ENDPOINTS_STORAGE_KEY, {
    endpoints: [{ hubId: HUB_ID, key: KEY, ws: WS }],
  });
};

const connectSocketIfNeeded = async (harness: ReturnType<typeof createHarness>) => {
  await vi.waitFor(() => {
    expect(harness.sockets).toHaveLength(1);
  });

  const [socket] = harness.sockets;

  if (socket === undefined) {
    throw new Error('expected a loopback socket');
  }

  return socket;
};

/** Runs the SPEC handshake and waits for `ext.hello`. */
const completeHandshake = async (socket: FakeSocket): Promise<void> => {
  socket.handlers.onOpen();
  const nonceH = nonce(0x11);
  socket.handlers.onText(JSON.stringify({ nonceH, type: 'challenge' }));

  await vi.waitFor(() => {
    expect(socket.sent).toHaveLength(1);
  });

  const auth = stringRecordSchema.parse(JSON.parse(socket.sent[0] ?? '{}'));
  const keyBytes = decodePairingKey(KEY);

  if (keyBytes === null) {
    throw new Error('test key must decode');
  }

  const hubMac = await computeHubMac(keyBytes, auth['nonceE'] ?? '', nonceH);
  socket.handlers.onText(JSON.stringify({ mac: hubMac, type: 'auth_ok' }));
  socket.handlers.onText(
    JSON.stringify({ hubVersion: '1.2.3', mode: 'loopback', protocol: [1], type: 'hub.hello' })
  );

  await vi.waitFor(() => {
    expect(sentWithType(socket.sent, 'ext.hello')).toBeDefined();
  });
};

const openSession = async (
  socket: FakeSocket,
  input: { cliVersion: string; cwd: string; title: string }
) => {
  socket.handlers.onText(
    JSON.stringify({ controllerId: CONTROLLER_ID, type: 'controller.connected' })
  );
  socket.handlers.onText(
    JSON.stringify({
      controllerId: CONTROLLER_ID,
      message: {
        id: 1,
        jsonrpc: '2.0',
        method: 'session.open',
        params: { ...input, sessionId: 'session-1' },
      },
      type: 'rpc',
    })
  );

  await vi.waitFor(() => {
    expect(rpcWith(socket.sent, 'id', 1)).toBeDefined();
  });

  return messageOf(rpcWith(socket.sent, 'id', 1));
};

describe('local agents host over a loopback endpoint', () => {
  it('pairs, handshakes, announces ext.hello, opens a session, and revokes on switch off', async () => {
    const harness = createHarness();
    seedEnabledWithEndpoint(harness.storage);
    const host = startHost(harness);
    await host.ready;
    const socket = await connectSocketIfNeeded(harness);

    await completeHandshake(socket);

    const hello = sentWithType(socket.sent, 'ext.hello');
    expect(hello?.['protocol']).toStrictEqual([1]);
    expect(hello?.['browser']).toStrictEqual({ name: 'Chrome', version: '140.0.0.0' });
    expect(hello?.['capabilities']).toStrictEqual({
      console: true,
      dialogs: true,
      fileUpload: true,
      network: false,
      tabGroups: false,
      trustedInput: false,
    });

    const response = await openSession(socket, {
      cliVersion: '1.4.0',
      cwd: '/Users/igor/Projects/kilo',
      title: 'Fix the tests',
    });
    const sessionHandle = sessionHandleOf(response);

    expect(sessionHandle).toBeTypeOf('string');
    await expect(loadLocalAgentConnectedAgents(harness.storage)).resolves.toStrictEqual([
      {
        cliVersion: '1.4.0',
        controllerId: CONTROLLER_ID,
        cwd: '/Users/igor/Projects/kilo',
        sessionHandle,
        sessionId: 'session-1',
        title: 'Fix the tests',
        transport: 'loopback',
      },
    ]);
    await vi.waitFor(async () => {
      const status = await loadLocalAgentStatus(harness.storage);
      expect(
        status.some(
          endpoint => endpoint.transport === 'loopback' && endpoint.state.kind === 'connected'
        )
      ).toBe(true);
    });

    harness.storage.items.set(LOCAL_AGENT_SETTINGS_STORAGE_KEY, { enabled: false });
    harness.storage.notify(LOCAL_AGENT_SETTINGS_STORAGE_KEY);

    await vi.waitFor(() => {
      expect(rpcWith(socket.sent, 'method', 'session.revoked')).toBeDefined();
    });

    expect(messageOf(rpcWith(socket.sent, 'method', 'session.revoked'))?.['params']).toStrictEqual({
      reason: 'switch_off',
      sessionHandle,
    });
    expect(socket.closed).toBeGreaterThan(0);
    await expect(loadLocalAgentConnectedAgents(harness.storage)).resolves.toStrictEqual([]);
    await expect(loadLocalAgentStatus(harness.storage)).resolves.toStrictEqual([]);
    expect(harness.alarms.clear).toHaveBeenCalledWith('kilo-local-agents-watchdog');
    host.stop();
  });

  it('pairs from the watched tab, stores the endpoint, and closes the tab', async () => {
    const harness = createHarness();
    harness.storage.items.set(LOCAL_AGENT_SETTINGS_STORAGE_KEY, { enabled: true });
    const host = startHost(harness);
    await host.ready;

    harness.listeners.tabUpdated?.(42, { url: PAIRING_URL }, { url: PAIRING_URL });

    await vi.waitFor(() => {
      expect(harness.storage.items.get(LOCAL_AGENT_ENDPOINTS_STORAGE_KEY)).toStrictEqual({
        endpoints: [{ hubId: HUB_ID, key: KEY, ws: WS }],
      });
    });
    await vi.waitFor(() => {
      expect(harness.sockets).toHaveLength(1);
    });
    expect(harness.removeTab).toHaveBeenCalledWith(42);
    expect(harness.sockets[0]?.url).toBe(WS);
    host.stop();
  });

  it('ignores pairing tabs while the switch is off', async () => {
    const harness = createHarness();
    harness.storage.items.set(LOCAL_AGENT_SETTINGS_STORAGE_KEY, { enabled: false });
    const host = startHost(harness);
    await host.ready;

    harness.listeners.tabUpdated?.(43, { url: PAIRING_URL }, { url: PAIRING_URL });

    // A disabled switch never reaches the pairing handler, so nothing async starts.
    expect(harness.storage.items.get(LOCAL_AGENT_ENDPOINTS_STORAGE_KEY)).toBeUndefined();
    expect(harness.sockets).toHaveLength(0);
    expect(harness.removeTab).not.toHaveBeenCalled();
    host.stop();
  });

  it('stops every agent from a panel command and answers the panel', async () => {
    const harness = createHarness();
    seedEnabledWithEndpoint(harness.storage);
    const host = startHost(harness);
    await host.ready;
    const socket = await connectSocketIfNeeded(harness);

    await completeHandshake(socket);
    const response = await openSession(socket, { cliVersion: '1', cwd: '/tmp', title: 't' });
    const sessionHandle = sessionHandleOf(response);

    await vi.waitFor(async () => {
      await expect(loadLocalAgentConnectedAgents(harness.storage)).resolves.toHaveLength(1);
    });

    const sendResponse = vi.fn();
    const returned = harness.listeners.message?.(
      { kind: 'stop_all', type: LOCAL_AGENTS_COMMAND_MESSAGE },
      { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/sidepanel.html` },
      sendResponse
    );

    expect(returned).toBe(true);

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    });

    expect(messageOf(rpcWith(socket.sent, 'method', 'session.revoked'))?.['params']).toStrictEqual({
      reason: 'user_stop',
      sessionHandle,
    });
    await expect(loadLocalAgentConnectedAgents(harness.storage)).resolves.toStrictEqual([]);
    host.stop();
  });

  it('refuses panel commands from a content-script sender', async () => {
    const harness = createHarness();
    harness.storage.items.set(LOCAL_AGENT_SETTINGS_STORAGE_KEY, { enabled: false });
    const host = startHost(harness);
    await host.ready;

    const sendResponse = vi.fn();
    const returned = harness.listeners.message?.(
      { kind: 'stop_all', type: LOCAL_AGENTS_COMMAND_MESSAGE },
      { id: EXTENSION_ID, url: 'https://evil.example' },
      sendResponse
    );

    expect(returned).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
    host.stop();
  });

  it('reports the native host as missing until a CLI installs it', async () => {
    const harness = createHarness();
    harness.storage.items.set(LOCAL_AGENT_SETTINGS_STORAGE_KEY, { enabled: true });
    const host = startHost(harness);
    await host.ready;

    await vi.waitFor(async () => {
      const status = await loadLocalAgentStatus(harness.storage);
      expect(status.find(endpoint => endpoint.transport === 'native')?.state).toStrictEqual({
        kind: 'host_missing',
        reason: 'permission_denied',
      });
    });
    host.stop();
  });

  it('writes nothing to the controller registry until a controller connects', async () => {
    const harness = createHarness();
    seedEnabledWithEndpoint(harness.storage);
    const host = startHost(harness);
    await host.ready;

    await connectSocketIfNeeded(harness);

    expect(harness.storage.items.get(LOCAL_AGENT_CONTROLLERS_STORAGE_KEY)).toBeUndefined();
    host.stop();
  });
});

describe('pairing admission', () => {
  it('buffers a pairing navigation until the first settings read answers', async () => {
    const harness = createHarness();
    seedEnabledWithEndpoint(harness.storage);
    const settingsRead = Promise.withResolvers<void>();
    harness.storage.getItem = async (key: LocalAgentStorageKey) => {
      if (key === LOCAL_AGENT_SETTINGS_STORAGE_KEY) {
        await settingsRead.promise;
      }

      return harness.storage.items.get(key) ?? null;
    };
    const host = startHost(harness);

    harness.listeners.tabUpdated?.(44, { url: PAIRING_URL }, { url: PAIRING_URL });
    expect(harness.sockets).toHaveLength(0);

    settingsRead.resolve();
    await host.ready;

    await vi.waitFor(() => {
      expect(harness.sockets).toHaveLength(1);
    });
    expect(harness.removeTab).toHaveBeenCalledWith(44);
    host.stop();
  });

  it('rejects a pairing navigation opened by a page', async () => {
    const harness = createHarness();
    harness.storage.items.set(LOCAL_AGENT_SETTINGS_STORAGE_KEY, { enabled: true });
    const host = startHost(harness);
    await host.ready;

    harness.listeners.tabUpdated?.(45, { url: PAIRING_URL }, { openerTabId: 7, url: PAIRING_URL });

    expect(harness.storage.items.get(LOCAL_AGENT_ENDPOINTS_STORAGE_KEY)).toBeUndefined();
    expect(harness.sockets).toHaveLength(0);
    host.stop();
  });

  it('pairs one fragment once, even when the navigation repeats', async () => {
    const harness = createHarness();
    harness.storage.items.set(LOCAL_AGENT_SETTINGS_STORAGE_KEY, { enabled: true });
    const host = startHost(harness);
    await host.ready;

    harness.listeners.tabUpdated?.(46, { url: PAIRING_URL }, { url: PAIRING_URL });
    harness.listeners.tabUpdated?.(47, { url: PAIRING_URL }, { url: PAIRING_URL });

    await vi.waitFor(() => {
      expect(harness.sockets).toHaveLength(1);
    });
    expect(harness.removeTab).toHaveBeenCalledWith(46);
    host.stop();
  });

  it('does not consume a fragment seen while the switch is off', async () => {
    const harness = createHarness();
    harness.storage.items.set(LOCAL_AGENT_SETTINGS_STORAGE_KEY, { enabled: false });
    const host = startHost(harness);
    await host.ready;

    harness.listeners.tabUpdated?.(50, { url: PAIRING_URL }, { url: PAIRING_URL });
    expect(harness.removeTab).not.toHaveBeenCalled();

    harness.storage.items.set(LOCAL_AGENT_SETTINGS_STORAGE_KEY, { enabled: true });
    harness.storage.notify(LOCAL_AGENT_SETTINGS_STORAGE_KEY);
    await vi.waitFor(() => {
      expect(harness.alarms.create).toHaveBeenCalledWith('kilo-local-agents-watchdog', {
        periodInMinutes: 0.5,
      });
    });

    harness.listeners.tabUpdated?.(51, { url: PAIRING_URL }, { url: PAIRING_URL });
    await vi.waitFor(() => {
      expect(harness.sockets).toHaveLength(1);
    });
    expect(harness.removeTab).toHaveBeenCalledWith(51);
    host.stop();
  });

  it('consumes the fragment only after the handshake succeeds', async () => {
    const harness = createHarness();
    harness.storage.items.set(LOCAL_AGENT_SETTINGS_STORAGE_KEY, { enabled: true });
    const host = startHost(harness);
    await host.ready;

    harness.listeners.tabUpdated?.(52, { url: PAIRING_URL }, { url: PAIRING_URL });
    const socket = await connectSocketIfNeeded(harness);
    await completeHandshake(socket);

    harness.listeners.tabUpdated?.(53, { url: PAIRING_URL }, { url: PAIRING_URL });

    expect(harness.removeTab).toHaveBeenCalledWith(52);
    expect(harness.removeTab).not.toHaveBeenCalledWith(53);
    expect(harness.sockets).toHaveLength(1);
    host.stop();
  });

  it('keeps the fragment reusable when its handshake fails', async () => {
    const harness = createHarness();
    harness.storage.items.set(LOCAL_AGENT_SETTINGS_STORAGE_KEY, { enabled: true });
    const host = startHost(harness);
    await host.ready;

    harness.listeners.tabUpdated?.(54, { url: PAIRING_URL }, { url: PAIRING_URL });
    const socket = await connectSocketIfNeeded(harness);
    socket.handlers.onError();

    await vi.waitFor(() => {
      expect(socket.closed).toBeGreaterThan(0);
    });

    harness.listeners.tabUpdated?.(55, { url: PAIRING_URL }, { url: PAIRING_URL });

    await vi.waitFor(() => {
      expect(harness.removeTab).toHaveBeenCalledWith(55);
    });
    expect(harness.sockets).toHaveLength(1);
    host.stop();
  });

  it('replaces the key and URL when the same hub pairs again, dropping its old rows', async () => {
    const harness = createHarness();
    seedEnabledWithEndpoint(harness.storage);
    const host = startHost(harness);
    await host.ready;
    const firstSocket = await connectSocketIfNeeded(harness);

    await completeHandshake(firstSocket);
    await openSession(firstSocket, { cliVersion: '1', cwd: '/tmp', title: 'old session' });
    await vi.waitFor(async () => {
      await expect(loadLocalAgentConnectedAgents(harness.storage)).resolves.toHaveLength(1);
    });

    harness.listeners.tabUpdated?.(48, { url: REPAIRING_URL }, { url: REPAIRING_URL });

    await vi.waitFor(() => {
      expect(harness.sockets).toHaveLength(2);
    });

    expect(firstSocket.closed).toBeGreaterThan(0);
    expect(harness.sockets[1]?.url).toBe(NEW_WS);
    await expect(loadLocalAgentConnectedAgents(harness.storage)).resolves.toStrictEqual([]);
    expect(harness.storage.items.get(LOCAL_AGENT_ENDPOINTS_STORAGE_KEY)).toStrictEqual({
      endpoints: [{ hubId: HUB_ID, key: NEW_KEY, ws: NEW_WS }],
    });
    host.stop();
  });

  it('does not resurrect a connection when the switch turns off while endpoints load', async () => {
    const harness = createHarness();
    seedEnabledWithEndpoint(harness.storage);
    const endpointsRead = Promise.withResolvers<void>();
    harness.storage.getItem = async (key: LocalAgentStorageKey) => {
      if (key === LOCAL_AGENT_ENDPOINTS_STORAGE_KEY) {
        await endpointsRead.promise;
      }

      return harness.storage.items.get(key) ?? null;
    };
    const host = startHost(harness);

    harness.storage.items.set(LOCAL_AGENT_SETTINGS_STORAGE_KEY, { enabled: false });
    harness.storage.notify(LOCAL_AGENT_SETTINGS_STORAGE_KEY);
    endpointsRead.resolve();
    await host.ready;

    expect(harness.sockets).toHaveLength(0);
    await expect(loadLocalAgentStatus(harness.storage)).resolves.toStrictEqual([]);
    host.stop();
  });
});
