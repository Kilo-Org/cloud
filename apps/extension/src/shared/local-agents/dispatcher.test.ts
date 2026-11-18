import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type {
  LocalAgentBrowserBridge,
  LocalAgentBrowserSessionOpen,
  LocalAgentBrowserSessionRef,
} from './browser-bridge';
import { createLocalAgentDispatcher } from './dispatcher';
import type { JsonRpcParams } from './jsonrpc';
import type { LocalAgentControllerRegistry } from './registry';
import { createLocalAgentControllerRegistry } from './registry';
import type { LocalAgentStorageArea } from './storage';

const CONTROLLER = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const OTHER_CONTROLLER = '11111111-2222-4333-8444-555555555555';

const createMemoryStorage = (): LocalAgentStorageArea => {
  const items = new Map<string, unknown>();

  return {
    getItem: (key: string) => items.get(key) ?? null,
    removeItem: (key: string) => {
      items.delete(key);
    },
    setItem: (key: string, value: unknown) => {
      items.set(key, value);
    },
  };
};

const sessionInput = { cliVersion: '1.4.0', cwd: '/tmp/kilo', sessionId: 'session-1', title: 'Work' };

type FakeBridge = {
  readonly adopt: Mock;
  readonly bridge: LocalAgentBrowserBridge;
  readonly callTool: Mock;
  readonly closeSession: Mock;
  readonly endSessions: Mock;
  readonly listTools: Mock;
  readonly openSession: Mock;
  readonly shareActiveTab: Mock;
};

const createFakeBridge = (): FakeBridge => {
  const adopt = vi.fn(async (_input: LocalAgentBrowserSessionRef) => ({}));
  const callTool = vi.fn(async (_controllerId: string, _params: JsonRpcParams) => ({
    content: [{ text: 'ok', type: 'text' }],
  }));
  const closeSession = vi.fn(async (_input: LocalAgentBrowserSessionRef) => {});
  const endSessions = vi.fn(async (_inputs: readonly LocalAgentBrowserSessionRef[]) => {});
  const listTools = vi.fn(async () => ({ contractSha: 'a'.repeat(64), tools: [] }));
  const openSession = vi.fn(async (_input: LocalAgentBrowserSessionOpen) => {});
  const shareActiveTab = vi.fn(async (_input: LocalAgentBrowserSessionRef) => ({ tabId: 5 }));
  const bridge: LocalAgentBrowserBridge = {
    adopt,
    callTool,
    closeSession,
    endSessions,
    listTools,
    openSession,
    shareActiveTab,
  };

  return {
    adopt,
    bridge,
    callTool,
    closeSession,
    endSessions,
    listTools,
    openSession,
    shareActiveTab,
  };
};

const createHarness = async () => {
  const registry: LocalAgentControllerRegistry = createLocalAgentControllerRegistry({
    createHandle: () => crypto.randomUUID(),
    now: () => 1000,
    storage: createMemoryStorage(),
  });
  const fake = createFakeBridge();
  const dispatcher = createLocalAgentDispatcher({ bridge: fake.bridge, registry });

  await registry.registerController({ controllerId: CONTROLLER, transport: 'loopback' });
  await registry.registerController({ controllerId: OTHER_CONTROLLER, transport: 'loopback' });

  return { dispatcher, fake, registry };
};

const openSession = async (
  dispatcher: ReturnType<typeof createLocalAgentDispatcher>,
  controllerId = CONTROLLER
) => {
  const result = await dispatcher.handle(controllerId, 'session.open', sessionInput);

  return String(result['sessionHandle']);
};

describe('local agent dispatcher', () => {
  it('hands the registry handle to the runtime session', async () => {
    const { dispatcher, fake } = await createHarness();
    const sessionHandle = await openSession(dispatcher);

    expect(sessionHandle).toMatch(/^[\da-f-]{36}$/u);
    expect(fake.openSession).toHaveBeenCalledWith({
      controllerId: CONTROLLER,
      sessionHandle,
      title: 'Work',
    });
  });

  it('rolls the session back when the browser cannot take one', async () => {
    const { dispatcher, fake, registry } = await createHarness();
    fake.openSession.mockRejectedValueOnce(new Error('no runtime'));

    await expect(dispatcher.handle(CONTROLLER, 'session.open', sessionInput)).rejects.toThrow(
      'no runtime'
    );
    await expect(registry.listConnectedAgents()).resolves.toStrictEqual([]);
  });

  it('routes a call only for the controller that opened the session', async () => {
    const { dispatcher, fake } = await createHarness();
    const sessionHandle = await openSession(dispatcher);

    await expect(
      dispatcher.handle(OTHER_CONTROLLER, 'tools.call', {
        arguments: {},
        authorized: [],
        name: 'browser_snapshot',
        sessionHandle,
      })
    ).rejects.toMatchObject({ code: -32_602 });
    expect(fake.callTool).not.toHaveBeenCalled();

    await expect(
      dispatcher.handle(CONTROLLER, 'tools.call', {
        arguments: {},
        authorized: [],
        name: 'browser_snapshot',
        sessionHandle,
      })
    ).resolves.toMatchObject({ content: [{ text: 'ok' }] });
    expect(fake.callTool).toHaveBeenCalledWith(CONTROLLER, {
      arguments: {},
      authorized: [],
      name: 'browser_snapshot',
      sessionHandle,
    });
  });

  it('closes the session in the registry and the runtime', async () => {
    const { dispatcher, fake, registry } = await createHarness();
    const sessionHandle = await openSession(dispatcher);

    await expect(
      dispatcher.handle(CONTROLLER, 'session.close', { sessionHandle })
    ).resolves.toStrictEqual({});
    expect(fake.closeSession).toHaveBeenCalledWith({ controllerId: CONTROLLER, sessionHandle });
    await expect(registry.listConnectedAgents()).resolves.toStrictEqual([]);

    await expect(
      dispatcher.handle(CONTROLLER, 'session.close', { sessionHandle })
    ).rejects.toMatchObject({ code: -32_602 });
  });

  it('routes adopt and share to the bridge for an owned session', async () => {
    const { dispatcher, fake } = await createHarness();
    const sessionHandle = await openSession(dispatcher);

    await expect(
      dispatcher.handle(CONTROLLER, 'session.shareActiveTab', { sessionHandle })
    ).resolves.toStrictEqual({ tabId: 5 });
    await expect(
      dispatcher.handle(CONTROLLER, 'session.adopt', { sessionHandle })
    ).resolves.toStrictEqual({});
    expect(fake.shareActiveTab).toHaveBeenCalledWith({ controllerId: CONTROLLER, sessionHandle });
    expect(fake.adopt).toHaveBeenCalledWith({ controllerId: CONTROLLER, sessionHandle });
  });

  it('refuses an unknown method and the upload transport it does not serve', async () => {
    const { dispatcher } = await createHarness();

    await expect(dispatcher.handle(CONTROLLER, 'session.nope', {})).rejects.toMatchObject({
      code: -32_601,
    });
    await expect(
      dispatcher.handle(CONTROLLER, 'upload.begin', {
        mimeType: 'text/plain',
        name: 'a.txt',
        size: 1,
        uploadId: 'u1',
      })
    ).rejects.toMatchObject({ code: -32_005 });
  });

  it('rejects malformed parameters before any work', async () => {
    const { dispatcher, fake } = await createHarness();

    await expect(dispatcher.handle(CONTROLLER, 'session.open', { title: 'Work' })).rejects.toMatchObject(
      { code: -32_602 }
    );
    await expect(dispatcher.handle(CONTROLLER, 'tools.list', {})).resolves.toMatchObject({
      contractSha: 'a'.repeat(64),
    });
    expect(fake.listTools).toHaveBeenCalledTimes(1);
  });
});
