import { describe, expect, it } from 'vitest';
import {
  createLocalAgentControllerRegistry,
  loadLocalAgentConnectedAgents,
  loadLocalAgentControllers,
} from './registry';
import type { LocalAgentStorageArea } from './storage';

const CONTROLLER_ID = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const SECOND_CONTROLLER_ID = '11111111-2222-4333-8444-555555555555';
const THIRD_CONTROLLER_ID = '99999999-8888-4777-8666-555555555555';

const createMemoryStorage = (): LocalAgentStorageArea & {
  items: Map<string, unknown>;
} => {
  const items = new Map<string, unknown>();

  return {
    getItem: (key: string) => items.get(key) ?? null,
    items,
    removeItem: (key: string) => {
      items.delete(key);
    },
    setItem: (key: string, value: unknown) => {
      items.set(key, value);
    },
  };
};

const createRegistry = () => {
  const storage = createMemoryStorage();

  return {
    registry: createLocalAgentControllerRegistry({
      createHandle: () => crypto.randomUUID(),
      now: () => 1000,
      storage,
    }),
    storage,
  };
};

describe('controller registry', () => {
  it('records a controller and its sessions for the connected-agents list', async () => {
    const { registry, storage } = createRegistry();

    await registry.registerController({ controllerId: CONTROLLER_ID, transport: 'loopback' });
    const opened = await registry.openSession(CONTROLLER_ID, {
      cliVersion: '1.2.3',
      cwd: '/Users/igor/Projects/kilo',
      sessionId: 'session-1',
      title: 'Fix the tests',
    });

    expect(opened.sessionHandle).toMatch(/^[\da-f-]{36}$/u);
    await expect(loadLocalAgentConnectedAgents(storage)).resolves.toStrictEqual([
      {
        cliVersion: '1.2.3',
        controllerId: CONTROLLER_ID,
        cwd: '/Users/igor/Projects/kilo',
        sessionHandle: opened.sessionHandle,
        sessionId: 'session-1',
        title: 'Fix the tests',
        transport: 'loopback',
      },
    ]);
  });

  it('keeps the controller row after its last session closes', async () => {
    const { registry } = createRegistry();

    await registry.registerController({ controllerId: CONTROLLER_ID, transport: 'native' });
    const opened = await registry.openSession(CONTROLLER_ID, {
      cliVersion: '1',
      cwd: '/tmp',
      sessionId: 's',
      title: 't',
    });

    await expect(registry.closeSession(CONTROLLER_ID, opened.sessionHandle)).resolves.toBe(true);
    await expect(registry.listConnectedAgents()).resolves.toStrictEqual([]);
    await expect(registry.listControllers()).resolves.toHaveLength(1);
  });

  it('names the controller that owns a session handle', async () => {
    const { registry } = createRegistry();

    await registry.registerController({ controllerId: CONTROLLER_ID, transport: 'native' });
    await registry.registerController({
      controllerId: SECOND_CONTROLLER_ID,
      transport: 'loopback',
    });
    const first = await registry.openSession(CONTROLLER_ID, {
      cliVersion: '1',
      cwd: '/tmp',
      sessionId: 's',
      title: 't',
    });
    const second = await registry.openSession(SECOND_CONTROLLER_ID, {
      cliVersion: '1',
      cwd: '/tmp',
      sessionId: 's2',
      title: 't2',
    });

    await expect(registry.sessionOwner(first.sessionHandle)).resolves.toBe(CONTROLLER_ID);
    await expect(registry.sessionOwner(second.sessionHandle)).resolves.toBe(
      SECOND_CONTROLLER_ID
    );
    await expect(registry.sessionOwner('99999999-8888-4777-8666-555555555555')).resolves.toBe(
      undefined
    );
  });

  it('refuses session.open for a controller that never announced itself', async () => {
    const { registry } = createRegistry();

    await expect(
      registry.openSession(SECOND_CONTROLLER_ID, {
        cliVersion: '1',
        cwd: '/tmp',
        sessionId: 's',
        title: 't',
      })
    ).rejects.toThrow('This controller is not connected.');
  });

  it('drops a disconnected controller and its sessions', async () => {
    const { registry, storage } = createRegistry();

    await registry.registerController({ controllerId: CONTROLLER_ID, transport: 'native' });
    await registry.openSession(CONTROLLER_ID, {
      cliVersion: '1',
      cwd: '/tmp',
      sessionId: 's',
      title: 't',
    });

    await expect(registry.removeController(CONTROLLER_ID)).resolves.not.toBeNull();
    await expect(loadLocalAgentControllers(storage)).resolves.toStrictEqual([]);
  });

  it('reports every open session and clears the registry for Stop all', async () => {
    const { registry, storage } = createRegistry();

    await registry.registerController({ controllerId: CONTROLLER_ID, transport: 'native' });
    await registry.registerController({
      controllerId: SECOND_CONTROLLER_ID,
      transport: 'loopback',
    });
    await registry.registerController({ controllerId: THIRD_CONTROLLER_ID, transport: 'loopback' });

    await Promise.all(
      [CONTROLLER_ID, SECOND_CONTROLLER_ID, THIRD_CONTROLLER_ID].map(controllerId =>
        registry.openSession(controllerId, {
          cliVersion: '1',
          cwd: '/tmp',
          sessionId: controllerId,
          title: controllerId,
        })
      )
    );

    const revoked = await registry.takeAllSessions();

    expect(revoked.map(entry => entry.controllerId).toSorted()).toStrictEqual(
      [CONTROLLER_ID, SECOND_CONTROLLER_ID, THIRD_CONTROLLER_ID].toSorted()
    );
    await expect(loadLocalAgentConnectedAgents(storage)).resolves.toStrictEqual([]);
  });

  it('serialises concurrent writes so no session is lost', async () => {
    const { registry } = createRegistry();

    await registry.registerController({ controllerId: CONTROLLER_ID, transport: 'native' });

    const handles = await Promise.all(
      ['a', 'b', 'c'].map(sessionId =>
        registry.openSession(CONTROLLER_ID, {
          cliVersion: '1',
          cwd: '/tmp',
          sessionId,
          title: sessionId,
        })
      )
    );

    expect(new Set(handles.map(handle => handle.sessionHandle)).size).toBe(3);
    await expect(registry.listConnectedAgents()).resolves.toHaveLength(3);
  });
});
