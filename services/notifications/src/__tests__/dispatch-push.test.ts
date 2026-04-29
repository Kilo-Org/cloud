import { env } from 'cloudflare:test';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import type { DispatchPushInput } from '@kilocode/notifications';

import { sendPushNotifications } from '../lib/expo-push';
import * as dbClient from '@kilocode/db/client';

vi.mock('../lib/expo-push', () => ({
  sendPushNotifications: vi.fn(async () => ({
    ticketTokenPairs: [{ ticket: { status: 'ok', id: 't1' }, token: 'tok1' }],
    staleTokens: [],
  })),
}));

type DbState = {
  tokens: { user_id: string; token: string }[];
  badgeTotal: number;
};

function installDbMock(state: DbState) {
  const fakeDb = {
    select: (cols?: unknown) => ({
      from: (table: Parameters<typeof getTableName>[0]) => ({
        where: async () => {
          if (getTableName(table) === 'user_push_tokens') {
            return state.tokens.map(t => ({ token: t.token }));
          }
          // sum(badge_count) — return single row with `total`
          return [{ total: state.badgeTotal }];
        },
      }),
    }),
    insert: () => ({
      values: () => ({ onConflictDoUpdate: async () => undefined }),
    }),
    delete: () => ({ where: async () => undefined }),
  };
  vi.spyOn(dbClient, 'getWorkerDb').mockReturnValue(
    fakeDb as unknown as ReturnType<typeof dbClient.getWorkerDb>
  );
}

const baseInput = (over: Partial<DispatchPushInput> = {}): DispatchPushInput => ({
  userId: 'user-1',
  presenceContext: '/presence/kiloclaw/sb1/conv1',
  idempotencyKey: 'k1',
  badge: { badgeBucket: 'conv1', delta: 1 },
  push: {
    title: 'T',
    body: 'B',
    data: { type: 'chat.message', sandboxId: 'sb1', conversationId: 'conv1', messageId: 'm1' },
    sound: 'default',
    priority: 'high',
  },
  ...over,
});

function getDO(name = 'conv1') {
  const id = env.NOTIFICATION_CHANNEL_DO.idFromName(name);
  return env.NOTIFICATION_CHANNEL_DO.get(id);
}

describe('NotificationChannelDO.dispatchPush', () => {
  beforeEach(() => {
    vi.mocked(sendPushNotifications).mockClear();
    vi.spyOn(env.EXPO_ACCESS_TOKEN, 'get').mockResolvedValue('test-token');
  });

  it('returns suppressed_presence when EVENT_SERVICE.isUserInContext is true', async () => {
    installDbMock({ tokens: [{ user_id: 'user-1', token: 'tok1' }], badgeTotal: 0 });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValueOnce(true);
    const result = await getDO().dispatchPush(baseInput());
    expect(result.kind).toBe('suppressed_presence');
    expect(sendPushNotifications).not.toHaveBeenCalled();
  });

  it('returns no_tokens when the user has no push tokens', async () => {
    installDbMock({ tokens: [], badgeTotal: 0 });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValueOnce(false);
    const result = await getDO().dispatchPush(baseInput({ userId: 'user-no-tokens' }));
    expect(result.kind).toBe('no_tokens');
    expect(sendPushNotifications).not.toHaveBeenCalled();
  });

  it('delivers, increments badge, writes idempotency key', async () => {
    installDbMock({ tokens: [{ user_id: 'u', token: 'tok1' }], badgeTotal: 1 });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValueOnce(false);
    const result = await getDO('conv-deliver').dispatchPush(
      baseInput({ idempotencyKey: 'k-deliver' })
    );
    expect(result.kind).toBe('delivered');
    expect(sendPushNotifications).toHaveBeenCalledOnce();
    const [[messages]] = vi.mocked(sendPushNotifications).mock.calls;
    expect(messages[0].badge).toBe(1);
  });

  it('returns duplicate when the idempotency key has been seen', async () => {
    installDbMock({ tokens: [{ user_id: 'u', token: 'tok1' }], badgeTotal: 1 });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    const stub = getDO('conv-dup');
    const input = baseInput({ idempotencyKey: 'k-dup' });
    await stub.dispatchPush(input);
    const second = await stub.dispatchPush(input);
    expect(second.kind).toBe('duplicate');
    expect(sendPushNotifications).toHaveBeenCalledOnce();
  });

  it('skips badge mutation when badge is null', async () => {
    installDbMock({ tokens: [{ user_id: 'u', token: 'tok1' }], badgeTotal: 0 });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValueOnce(false);
    const result = await getDO('conv-no-badge').dispatchPush(
      baseInput({ badge: null, idempotencyKey: 'k-no-badge' })
    );
    expect(result.kind).toBe('delivered');
    const [[messages]] = vi.mocked(sendPushNotifications).mock.calls;
    expect(messages[0].badge).toBeUndefined();
  });

  it('does not write idempotency key on Expo failure', async () => {
    installDbMock({ tokens: [{ user_id: 'u', token: 'tok1' }], badgeTotal: 0 });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    vi.mocked(sendPushNotifications).mockRejectedValueOnce(new Error('boom'));
    const stub = getDO('conv-fail');
    const input = baseInput({ idempotencyKey: 'k-fail', badge: null });
    const first = await stub.dispatchPush(input);
    expect(first.kind).toBe('failed');
    const second = await stub.dispatchPush(input);
    expect(second.kind).not.toBe('duplicate');
  });
});
