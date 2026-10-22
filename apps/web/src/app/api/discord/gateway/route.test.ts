import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { NextRequest, type NextResponse } from 'next/server';
import { Client, Events } from 'discord.js';
import { GET } from './route';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  CRON_SECRET: 'fixture-cron',
  DISCORD_BOT_TOKEN: 'fixture-bot',
}));
jest.mock('@kilocode/web-shared/lib/constants', () => ({ APP_URL: 'http://localhost:3000' }));
jest.mock('discord.js', () => ({
  Client: jest.fn(),
  Events: { ClientReady: 'ready', Error: 'error' },
  GatewayIntentBits: {},
}));

let mockListenerId: string | undefined;
const mockOwnerRead = jest.fn(async () =>
  mockListenerId ? [{ listener_id: mockListenerId }] : []
);
const mockClaim = jest.fn(async () => undefined);
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  sql: jest.fn(),
  db: {
    insert: () => ({
      values: (values: { listener_id: string }) => ({
        onConflictDoUpdate: async () => {
          await mockClaim();
          mockListenerId = values.listener_id;
        },
      }),
    }),
    select: () => ({ from: () => ({ where: () => ({ limit: mockOwnerRead }) }) }),
  },
}));

type FixtureClient = EventEmitter & {
  login: jest.Mock<Promise<string>, []>;
  destroy: jest.Mock<Promise<void>, []>;
};

const botId = '111111111111111111';
function packet(id = '555555555555555555') {
  return {
    t: 'MESSAGE_CREATE',
    d: {
      id,
      channel_id: '222222222222222222',
      guild_id: '333333333333333333',
      author: { id: '444444444444444444', username: 'fixture' },
      content: `<@${botId}> hello`,
      mentions: [{ id: botId }],
    },
  };
}

async function until(condition: () => boolean) {
  const deadline = performance.now() + 2_000;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error('Fixture condition did not complete');
    await setImmediate();
  }
}

const clients: FixtureClient[] = [];
const requests: Array<Promise<NextResponse>> = [];
const fetchMock = jest.fn<Promise<Response>, Parameters<typeof fetch>>();
const originalFetch = global.fetch;

async function startListener() {
  const request = GET(
    new NextRequest('http://localhost:3000/api/discord/gateway', {
      headers: { authorization: 'Bearer fixture-cron' },
    })
  );
  requests.push(request);
  const client = clients[clients.length - 1];
  const previousOwner = mockListenerId;
  client.emit(Events.ClientReady, { user: { id: botId } });
  await until(() => mockListenerId !== previousOwner);
  await setImmediate();
  return { client, request };
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'performance'] });
  mockListenerId = undefined;
  mockOwnerRead.mockImplementation(async () =>
    mockListenerId ? [{ listener_id: mockListenerId }] : []
  );
  mockClaim.mockResolvedValue(undefined);
  clients.length = 0;
  requests.length = 0;
  jest.mocked(Client).mockImplementation(() => {
    const client = Object.assign(new EventEmitter(), {
      login: jest.fn(async () => 'fixture-bot'),
      destroy: jest.fn(async () => undefined),
    });
    clients.push(client);
    return client as unknown as Client;
  });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
  global.fetch = fetchMock;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  mockListenerId = undefined;
  await jest.advanceTimersByTimeAsync(10_000);
  await Promise.all(requests);
  jest.useRealTimers();
  global.fetch = originalFetch;
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe('Discord gateway delivery', () => {
  it('reserves bounded forwarding capacity', async () => {
    const { client } = await startListener();
    const pending: Array<PromiseWithResolvers<Response>> = [];
    fetchMock.mockImplementation((_url, init) => {
      const result = Promise.withResolvers<Response>();
      pending.push(result);
      init?.signal?.addEventListener('abort', () => result.reject(init.signal?.reason), {
        once: true,
      });
      return result.promise;
    });
    for (let i = 0; i < 20; i++)
      client.emit('raw', packet(String(BigInt('555555555555555555') + BigInt(i))));
    await until(() => fetchMock.mock.calls.length === 8);
    expect(mockOwnerRead).toHaveBeenCalledTimes(8);
    expect(console.warn).toHaveBeenCalledTimes(1);
    pending[0].resolve(new Response(null));
    await setImmediate();
    client.emit('raw', packet('666666666666666666'));
    await until(() => fetchMock.mock.calls.length === 9);
    for (const result of pending) result.resolve(new Response(null));
    await setImmediate();
    expect(fetchMock).toHaveBeenCalledTimes(9);
  });

  it('bounds ownership checks with forwarding capacity', async () => {
    const { client } = await startListener();
    const owner = Promise.withResolvers<Array<{ listener_id: string }>>();
    mockOwnerRead.mockReturnValue(owner.promise);
    for (let i = 0; i < 20; i++) client.emit('raw', packet());
    expect(mockOwnerRead).toHaveBeenCalledTimes(8);
    expect(fetchMock).not.toHaveBeenCalled();
    owner.resolve([]);
    await requests[0];
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it('follows current listener ownership', async () => {
    const first = await startListener();
    const second = await startListener();
    first.client.emit('raw', packet());
    second.client.emit('raw', packet());
    await first.request;
    expect(first.client.destroy).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.client.destroy).not.toHaveBeenCalled();
  });

  it('requires confirmed ownership', async () => {
    const { client, request } = await startListener();
    mockOwnerRead.mockRejectedValueOnce(new Error('Fixture unavailable'));
    client.emit('raw', packet());
    await request;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it('applies the forwarding deadline', async () => {
    const { client } = await startListener();
    const deadline = new AbortController();
    jest.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const finished = Promise.withResolvers<void>();
    fetchMock.mockImplementation((_url, init) => {
      const result = Promise.withResolvers<Response>();
      init?.signal?.addEventListener(
        'abort',
        () => {
          result.reject(init.signal?.reason);
          finished.resolve();
        },
        { once: true }
      );
      return result.promise;
    });
    client.emit('raw', packet());
    await until(() => fetchMock.mock.calls.length === 1);
    expect(AbortSignal.timeout).toHaveBeenCalledWith(10_000);
    deadline.abort(new DOMException('Fixture deadline', 'TimeoutError'));
    await finished.promise;
    await setImmediate();
    fetchMock.mockResolvedValue(new Response(null));
    client.emit('raw', packet('666666666666666666'));
    await until(() => fetchMock.mock.calls.length === 2);
  });

  it('cancels requests at listener completion', async () => {
    const { client, request } = await startListener();
    let signal: AbortSignal | null | undefined;
    fetchMock.mockImplementation((_url, init) => {
      signal = init?.signal;
      const result = Promise.withResolvers<Response>();
      signal?.addEventListener('abort', () => result.reject(signal?.reason), { once: true });
      return result.promise;
    });
    client.emit('raw', packet());
    await until(() => fetchMock.mock.calls.length === 1);
    mockListenerId = undefined;
    client.emit('raw', packet('666666666666666666'));
    await request;
    expect(signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('selects processable messages', async () => {
    const { client } = await startListener();
    client.emit('raw', { ...packet(), t: 'MESSAGE_UPDATE' });
    client.emit('raw', { t: 'MESSAGE_CREATE', d: { ...packet().d, mentions: [] } });
    client.emit('raw', { t: 'MESSAGE_CREATE', d: { ...packet().d, guild_id: undefined } });
    client.emit('raw', { t: 'MESSAGE_CREATE', d: { ...packet().d, content: `<@${botId}>` } });
    client.emit('raw', {
      t: 'MESSAGE_CREATE',
      d: { ...packet().d, author: { ...packet().d.author, bot: true } },
    });
    client.emit('raw', packet());
    await until(() => fetchMock.mock.calls.length === 1);
    expect(mockOwnerRead).toHaveBeenCalledTimes(1);
  });

  it('finishes a failed login', async () => {
    jest.mocked(Client).mockImplementationOnce(() => {
      const client = Object.assign(new EventEmitter(), {
        login: jest.fn(async () => {
          throw new Error('Fixture login failed');
        }),
        destroy: jest.fn(async () => undefined),
      });
      clients.push(client);
      return client as unknown as Client;
    });
    const response = await GET(
      new NextRequest('http://localhost:3000/api/discord/gateway', {
        headers: { authorization: 'Bearer fixture-cron' },
      })
    );
    expect(response.status).toBe(500);
    expect(clients[0].destroy).toHaveBeenCalledTimes(1);
    expect(mockListenerId).toBeUndefined();
  });
});
