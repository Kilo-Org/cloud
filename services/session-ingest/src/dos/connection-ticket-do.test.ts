import { describe, expect, it, vi } from 'vitest';

// Mock cloudflare:workers before importing ConnectionTicketDO.
vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    ctx: unknown;
    env: unknown;
    constructor(state: unknown, env: unknown) {
      this.ctx = state;
      this.env = env;
    }
  },
}));

import { ConnectionTicketDO } from './connection-ticket-do';

function makeStorage() {
  const store = new Map<string, unknown>();
  let alarm: number | null = null;

  const storage = {
    put: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    get: async <T>(key: string): Promise<T | undefined> => store.get(key) as T | undefined,
    delete: async (key: string) => {
      store.delete(key);
    },
    setAlarm: async (at: number) => {
      alarm = at;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
    transaction: async <T>(
      fn: (txn: {
        get: <T2>(key: string) => Promise<T2 | undefined>;
        delete: (key: string) => Promise<void>;
      }) => Promise<T>
    ): Promise<T> => {
      const txn = {
        get: async <T2>(key: string): Promise<T2 | undefined> => store.get(key) as T2 | undefined,
        delete: async (key: string) => {
          store.delete(key);
        },
      };
      return fn(txn);
    },
  };

  return { store, storage, getAlarm: () => alarm };
}

function makeDO() {
  const { store, storage, getAlarm } = makeStorage();
  const instance = new ConnectionTicketDO({ storage } as never, {} as never);
  return { instance, store, getAlarm };
}

const SECRET = 'ticket-secret';

describe('ConnectionTicketDO', () => {
  it('mints a ticket by storing state and arming an alarm', async () => {
    const { instance, store, getAlarm } = makeDO();
    const expiresAt = Date.now() + 60_000;

    await instance.mint({ userId: 'usr_1', expiresAt, secret: SECRET });

    expect(store.get('ticket')).toEqual({ userId: 'usr_1', expiresAt, secret: SECRET });
    expect(getAlarm()).toBe(expiresAt);
  });

  it('inspects a valid ticket without consuming its state or alarm', async () => {
    const { instance, store, getAlarm } = makeDO();
    const ticket = {
      userId: 'usr_1',
      deviceSessionId: 'device-1',
      expiresAt: Date.now() + 60_000,
      secret: SECRET,
    };
    await instance.mint(ticket);

    await expect(instance.inspect(SECRET)).resolves.toEqual({
      userId: ticket.userId,
      deviceSessionId: ticket.deviceSessionId,
    });
    expect(store.get('ticket')).toEqual(ticket);
    expect(getAlarm()).toBe(ticket.expiresAt);
    await expect(instance.consume(SECRET)).resolves.toEqual({
      userId: ticket.userId,
      deviceSessionId: ticket.deviceSessionId,
    });
    await expect(instance.inspect(SECRET)).resolves.toBeNull();
  });

  it.each(['expired', 'wrong-secret'] as const)('burns an invalid inspection: %s', async reason => {
    const { instance, store } = makeDO();
    await instance.mint({
      userId: 'usr_1',
      expiresAt: Date.now() + (reason === 'expired' ? -1 : 60_000),
      secret: SECRET,
    });
    await expect(
      instance.inspect(reason === 'wrong-secret' ? 'wrong-secret' : SECRET)
    ).resolves.toBeNull();
    expect(store.get('ticket')).toBeUndefined();
  });

  it('consumes a fresh ticket once and returns the userId', async () => {
    const { instance } = makeDO();
    await instance.mint({ userId: 'usr_1', expiresAt: Date.now() + 60_000, secret: SECRET });

    await expect(instance.consume(SECRET)).resolves.toEqual({ userId: 'usr_1' });
  });

  it('rejects a replay of an already-consumed ticket', async () => {
    const { instance } = makeDO();
    await instance.mint({ userId: 'usr_1', expiresAt: Date.now() + 60_000, secret: SECRET });

    await expect(instance.consume(SECRET)).resolves.toEqual({ userId: 'usr_1' });
    await expect(instance.consume(SECRET)).resolves.toBeNull();
  });

  it('rejects an expired ticket', async () => {
    const { instance } = makeDO();
    await instance.mint({ userId: 'usr_1', expiresAt: Date.now() - 1, secret: SECRET });

    await expect(instance.consume(SECRET)).resolves.toBeNull();
  });

  it('rejects a wrong secret and burns the ticket', async () => {
    const { instance, store } = makeDO();
    await instance.mint({ userId: 'usr_1', expiresAt: Date.now() + 60_000, secret: SECRET });

    await expect(instance.consume('wrong-secret')).resolves.toBeNull();
    expect(store.get('ticket')).toBeUndefined();
    await expect(instance.consume(SECRET)).resolves.toBeNull();
  });

  it('rejects a stored ticket without a secret', async () => {
    const { instance, store } = makeDO();
    store.set('ticket', { userId: 'usr_1', expiresAt: Date.now() + 60_000 });

    await expect(instance.consume(SECRET)).resolves.toBeNull();
  });

  it('deletes ticket storage and alarm after a successful consume', async () => {
    const { instance, store, getAlarm } = makeDO();
    const expiresAt = Date.now() + 60_000;
    await instance.mint({ userId: 'usr_1', expiresAt, secret: SECRET });

    expect(store.get('ticket')).toEqual({ userId: 'usr_1', expiresAt, secret: SECRET });
    expect(getAlarm()).toBe(expiresAt);

    await expect(instance.consume(SECRET)).resolves.toEqual({ userId: 'usr_1' });

    expect(store.get('ticket')).toBeUndefined();
    expect(getAlarm()).toBeNull();
  });

  it('deletes unconsumed expired ticket storage when the alarm runs', async () => {
    const { instance, store } = makeDO();
    await instance.mint({ userId: 'usr_1', expiresAt: Date.now() + 60_000, secret: SECRET });

    // Simulate expiry before the alarm fires.
    store.set('ticket', { userId: 'usr_1', expiresAt: Date.now() - 1, secret: SECRET });
    await instance.alarm();

    expect(store.get('ticket')).toBeUndefined();
  });
});
