import { env, runInDurableObject } from 'cloudflare:test';
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
    select: () => ({
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

  it('does not re-increment the badge when retrying after Expo failure', async () => {
    const insertSpy = vi.fn().mockReturnValue({
      values: () => ({ onConflictDoUpdate: async () => undefined }),
    });
    vi.spyOn(dbClient, 'getWorkerDb').mockReturnValue({
      select: () => ({
        from: (table: Parameters<typeof getTableName>[0]) => ({
          where: async () => {
            if (getTableName(table) === 'user_push_tokens') {
              return [{ token: 'tok1' }];
            }
            return [{ total: 1 }];
          },
        }),
      }),
      insert: insertSpy,
      delete: () => ({ where: async () => undefined }),
    } as unknown as ReturnType<typeof dbClient.getWorkerDb>);
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    vi.mocked(sendPushNotifications).mockRejectedValueOnce(new Error('boom'));

    const stub = getDO('conv-no-double');
    const input = baseInput({ idempotencyKey: 'k-no-double' });

    const first = await stub.dispatchPush(input);
    expect(first.kind).toBe('failed');
    expect(insertSpy).toHaveBeenCalledTimes(1);

    const second = await stub.dispatchPush(input);
    expect(second.kind).toBe('delivered');
    // Badge must not be incremented twice across the retry — the first
    // attempt's `pending` marker gates the second insert out.
    expect(insertSpy).toHaveBeenCalledTimes(1);
  });

  it('schedules cleanup when writing the pending marker (failed send)', async () => {
    installDbMock({ tokens: [{ user_id: 'u', token: 'tok1' }], badgeTotal: 0 });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    vi.mocked(sendPushNotifications).mockRejectedValueOnce(new Error('boom'));
    const stub = getDO('conv-pending-alarm');

    const result = await stub.dispatchPush(baseInput({ idempotencyKey: 'k-pending-alarm' }));
    expect(result.kind).toBe('failed');
    // Even though delivery failed, an alarm must be set so the orphan
    // `pending` record gets pruned after IDEM_TTL_MS.
    const alarm = await runInDurableObject(stub, (_inst, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
  });

  it('reschedules cleanup for younger records when alarm fires', async () => {
    installDbMock({ tokens: [{ user_id: 'u', token: 'tok1' }], badgeTotal: 1 });
    const stub = getDO('conv-reschedule');

    const now = Date.now();
    await runInDurableObject(stub, async (_inst, state) => {
      await state.storage.put('idem:old', { stage: 'delivered', ts: now - 2 * 60 * 60 * 1000 });
      await state.storage.put('idem:new', { stage: 'delivered', ts: now - 30 * 60 * 1000 });
    });

    await runInDurableObject(stub, async inst => {
      await (inst as unknown as { alarm: () => Promise<void> }).alarm();
    });

    const remaining = await runInDurableObject(stub, async (_inst, state) => {
      const entries = await state.storage.list({ prefix: 'idem:' });
      return Array.from(entries.keys());
    });
    expect(remaining).toEqual(['idem:new']);

    const alarm = await runInDurableObject(stub, (_inst, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    // Should be rescheduled for the younger record's expiry, not "1h from now".
    const expectedExpiry = now - 30 * 60 * 1000 + 60 * 60 * 1000;
    expect(alarm).toBe(expectedExpiry);
  });

  it('does not reset the alarm on every successful send', async () => {
    installDbMock({ tokens: [{ user_id: 'u', token: 'tok1' }], badgeTotal: 1 });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    const stub = getDO('conv-alarm');

    await stub.dispatchPush(baseInput({ idempotencyKey: 'k-alarm-1' }));
    const firstAlarm = await runInDurableObject(stub, (_inst, state) => state.storage.getAlarm());
    expect(firstAlarm).not.toBeNull();

    // Advance Date.now so a naive setAlarm would push the alarm forward.
    const realNow = Date.now;
    try {
      vi.spyOn(Date, 'now').mockImplementation(() => realNow.call(Date) + 60_000);
      await stub.dispatchPush(baseInput({ idempotencyKey: 'k-alarm-2' }));
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
    const secondAlarm = await runInDurableObject(stub, (_inst, state) => state.storage.getAlarm());
    expect(secondAlarm).toBe(firstAlarm);
  });
});
