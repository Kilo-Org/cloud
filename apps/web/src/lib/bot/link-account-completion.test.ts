process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'test-nextauth-secret',
}));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/bot', () => ({
  bot: { getState: jest.fn() },
}));
jest.mock('@/lib/bot/platform-helpers', () => ({
  getPlatformIntegration: jest.fn(),
}));
jest.mock('@/lib/bot/platforms', () => ({
  botPlatforms: { require: jest.fn() },
}));
jest.mock('@/lib/bot/run', () => ({
  processLinkedMessage: jest.fn(),
}));
jest.mock(
  'chat',
  () => ({
    Message: { fromJSON: jest.fn((value: unknown) => value) },
    ThreadImpl: { fromJSON: jest.fn((value: unknown) => value) },
  }),
  { virtual: true }
);

import { bot } from '@/lib/bot';
import {
  createLinkAccountToken,
  linkKiloUser,
  resolveKiloUserId,
  type PlatformIdentity,
} from '@/lib/bot-identity';
import { completeLinkAccount } from './link-account-completion';

const KILO_USER_ID = 'kilo-user-1';
const OTHER_KILO_USER_ID = 'kilo-user-2';

const identity: PlatformIdentity = { platform: 'slack', teamId: 'T1', userId: 'U1' };

const thread = {
  _type: 'chat:Thread' as const,
  adapterName: 'slack',
  channelId: 'C1',
  id: 'thread',
  isDM: false,
};
const message = {
  _type: 'chat:Message' as const,
  attachments: [],
  author: {
    userId: 'U1',
    userName: 'user',
    fullName: 'User',
    isBot: false,
    isMe: false,
  },
  formatted: null,
  id: 'message',
  metadata: { dateSent: '2026-09-08T00:00:00.000Z', edited: false },
  raw: null,
  text: 'link',
  threadId: 'thread',
};

type FakeState = {
  values: Map<string, unknown>;
  set(key: string, value: unknown, ttl?: number): Promise<void>;
  get(key: string): Promise<unknown>;
  setIfNotExists(key: string, value: unknown, ttl?: number): Promise<boolean>;
  delete(key: string): Promise<void>;
};

function createState(): FakeState {
  const values = new Map<string, unknown>();
  return {
    values,
    set: async (key, value) => {
      values.set(key, value);
    },
    get: async key => values.get(key) ?? null,
    setIfNotExists: async (key, value) => {
      if (values.has(key)) return false;
      values.set(key, value);
      return true;
    },
    delete: async key => {
      values.delete(key);
    },
  };
}

const user = { id: KILO_USER_ID } as never;

let state: FakeState;

/** Store a pending link the way the bot's link prompt does, and return its key. */
async function seedPendingLink(): Promise<string> {
  await createLinkAccountToken({
    identity,
    thread: thread as never,
    message: message as never,
    state: state as never,
  });
  const contextKey = [...state.values.keys()].find(
    key => key.startsWith('link-account-context:') && !key.endsWith(':consumed')
  );
  if (!contextKey) throw new Error('Expected a pending link context');
  return contextKey;
}

function complete(contextKey: string) {
  return completeLinkAccount({ identity, contextKey, user });
}

beforeEach(() => {
  state = createState();
  jest.mocked(bot.getState).mockReturnValue(state as never);
});

test('a conflict leaves the pending link unspent and keeps refusing the identity', async () => {
  await linkKiloUser(state as never, identity, OTHER_KILO_USER_ID);
  const contextKey = await seedPendingLink();

  await expect(complete(contextKey)).resolves.toEqual({ status: 'conflict' });
  expect(state.values.has(`${contextKey}:consumed`)).toBe(false);
  await expect(resolveKiloUserId(state as never, identity)).resolves.toBe(OTHER_KILO_USER_ID);

  await expect(complete(contextKey)).resolves.toEqual({ status: 'conflict' });
  expect(state.values.has(`${contextKey}:consumed`)).toBe(false);

  await state.delete('identity:slack:T1:U1');
  await expect(complete(contextKey)).resolves.toEqual({
    status: 'linked',
    context: { thread, message },
  });
  await expect(resolveKiloUserId(state as never, identity)).resolves.toBe(KILO_USER_ID);
});

test('a transient state-store failure leaves the pending link usable', async () => {
  const contextKey = await seedPendingLink();
  const setIfNotExists = state.setIfNotExists;
  let mappingAttempts = 0;
  state.setIfNotExists = async (key, value, ttl) => {
    if (!key.endsWith(':consumed')) {
      mappingAttempts += 1;
      if (mappingAttempts === 1) throw new Error('state store unavailable');
    }
    return await setIfNotExists(key, value, ttl);
  };

  await expect(complete(contextKey)).rejects.toThrow('state store unavailable');
  expect(state.values.has(`${contextKey}:consumed`)).toBe(false);
  await expect(resolveKiloUserId(state as never, identity)).resolves.toBeNull();

  await expect(complete(contextKey)).resolves.toEqual({
    status: 'linked',
    context: { thread, message },
  });
  await expect(resolveKiloUserId(state as never, identity)).resolves.toBe(KILO_USER_ID);
});

test('a spent link reports used without writing a mapping', async () => {
  const contextKey = await seedPendingLink();
  await state.set(`${contextKey}:consumed`, true);

  await expect(complete(contextKey)).resolves.toEqual({ status: 'used' });
  await expect(resolveKiloUserId(state as never, identity)).resolves.toBeNull();
});

test('a missing context reports context_missing and writes nothing', async () => {
  await expect(complete('link-account-context:deleted')).resolves.toEqual({
    status: 'context_missing',
  });
  expect(state.values.size).toBe(0);
});

test('a link completes once and reports the stored context', async () => {
  const contextKey = await seedPendingLink();

  await expect(complete(contextKey)).resolves.toEqual({
    status: 'linked',
    context: { thread, message },
  });
  await expect(resolveKiloUserId(state as never, identity)).resolves.toBe(KILO_USER_ID);
  expect(state.values.has(`${contextKey}:consumed`)).toBe(true);

  await expect(complete(contextKey)).resolves.toEqual({ status: 'used' });
  await expect(resolveKiloUserId(state as never, identity)).resolves.toBe(KILO_USER_ID);
});

test('a lost claim reports the link as this account without a second replay', async () => {
  await linkKiloUser(state as never, identity, KILO_USER_ID);
  const contextKey = await seedPendingLink();

  // A concurrent submission takes the single-use claim after this call passed
  // the spent-link pre-check.
  const setIfNotExists = state.setIfNotExists;
  state.setIfNotExists = async (key, value, ttl) => {
    if (key.endsWith(':consumed')) return false;
    return await setIfNotExists(key, value, ttl);
  };

  await expect(complete(contextKey)).resolves.toEqual({ status: 'linked_elsewhere' });
  await expect(resolveKiloUserId(state as never, identity)).resolves.toBe(KILO_USER_ID);
});

test('a failing claim keeps the link and reports it as this account', async () => {
  const contextKey = await seedPendingLink();

  const setIfNotExists = state.setIfNotExists;
  state.setIfNotExists = async (key, value, ttl) => {
    if (key.endsWith(':consumed')) throw new Error('claim unavailable');
    return await setIfNotExists(key, value, ttl);
  };

  await expect(complete(contextKey)).resolves.toEqual({ status: 'linked_elsewhere' });
  await expect(resolveKiloUserId(state as never, identity)).resolves.toBe(KILO_USER_ID);
  expect(state.values.has(`${contextKey}:consumed`)).toBe(false);
});

test('only the claim winner gets a context to replay', async () => {
  const contextKey = await seedPendingLink();

  const first = await complete(contextKey);
  expect(first).toEqual({ status: 'linked', context: { thread, message } });

  // A concurrent submission read the spent-link pre-check before the first
  // call took the claim, then lost the claim itself.
  const get = state.get;
  state.get = async key => (key.endsWith(':consumed') ? null : await get(key));

  const second = await complete(contextKey);
  expect(second).toEqual({ status: 'linked_elsewhere' });
  expect(second).not.toHaveProperty('context');
  expect([first, second].filter(outcome => 'context' in outcome)).toHaveLength(1);
  await expect(resolveKiloUserId(state as never, identity)).resolves.toBe(KILO_USER_ID);
});
