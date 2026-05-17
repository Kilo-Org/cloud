import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import type { DispatchPushInput } from '@kilocode/notifications';

import { sendPushNotifications } from '../lib/expo-push';
import * as dbClient from '@kilocode/db/client';

vi.mock('../lib/expo-push', () => ({
  sendPushNotifications: vi.fn(async () => ({
    ticketTokenPairs: [{ ticketId: 't1', token: 'tok1' }],
    staleTokens: [],
    ticketErrors: [],
  })),
}));

type DbState = {
  tokens: { user_id: string; token: string }[];
  staleTokensToDelete?: string[];
  deleteCalls?: number;
};

function installDbMock(state: DbState) {
  const fakeDb = {
    select: () => ({
      from: (table: Parameters<typeof getTableName>[0]) => ({
        where: async () => {
          if (getTableName(table) === 'user_push_tokens') {
            return state.tokens.map(t => ({ token: t.token }));
          }
          return [];
        },
      }),
    }),
    insert: () => ({
      values: () => ({ onConflictDoUpdate: async () => undefined }),
    }),
    delete: () => ({
      where: async () => {
        state.deleteCalls = (state.deleteCalls ?? 0) + 1;
        const staleTokens = new Set(state.staleTokensToDelete ?? []);
        state.tokens = state.tokens.filter(row => !staleTokens.has(row.token));
      },
    }),
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

function getDO(name = 'user-1') {
  const id = env.NOTIFICATION_CHANNEL_DO.idFromName(name);
  return env.NOTIFICATION_CHANNEL_DO.get(id);
}

describe('NotificationChannelDO.dispatchPush', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(env.EXPO_ACCESS_TOKEN, 'get').mockResolvedValue('test-token');
  });

  it('returns suppressed_presence when EVENT_SERVICE.isUserInContext is true', async () => {
    installDbMock({ tokens: [{ user_id: 'user-1', token: 'tok1' }] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValueOnce(true);
    const result = await getDO().dispatchPush(baseInput());
    expect(result.kind).toBe('suppressed_presence');
    expect(sendPushNotifications).not.toHaveBeenCalled();
  });

  it('records presence suppression as terminal idempotency', async () => {
    installDbMock({ tokens: [{ user_id: 'u', token: 'tok1' }] });
    const presenceSpy = vi
      .spyOn(env.EVENT_SERVICE, 'isUserInContext')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const stub = getDO('user-suppressed-idem');
    const input = baseInput({
      userId: 'user-suppressed-idem',
      idempotencyKey: 'k-suppressed-idem',
    });

    const first = await stub.dispatchPush(input);
    const second = await stub.dispatchPush(input);

    expect(first.kind).toBe('suppressed_presence');
    expect(second.kind).toBe('duplicate');
    expect(presenceSpy).toHaveBeenCalledOnce();
    expect(sendPushNotifications).not.toHaveBeenCalled();

    const stored = await runInDurableObject(stub, async (_inst, state) => {
      const buckets = await state.storage.list<number>({ prefix: 'bucket:' });
      return {
        buckets: Array.from(buckets.entries()),
        total: await state.storage.get<number>('total'),
        idem: await state.storage.get<{ stage: string; ts: number }>('idem:k-suppressed-idem'),
        alarm: await state.storage.getAlarm(),
      };
    });
    expect(stored.buckets).toEqual([]);
    expect(stored.total).toBeUndefined();
    expect(stored.idem).toMatchObject({ stage: 'suppressed' });
    expect(stored.alarm).not.toBeNull();
  });

  it('returns no_tokens when the user has no push tokens', async () => {
    installDbMock({ tokens: [] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValueOnce(false);
    const result = await getDO('user-no-tokens').dispatchPush(
      baseInput({ userId: 'user-no-tokens' })
    );
    expect(result.kind).toBe('no_tokens');
    expect(sendPushNotifications).not.toHaveBeenCalled();
  });

  it('records unread badge buckets even when the user has no push tokens', async () => {
    installDbMock({ tokens: [] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    const stub = getDO('user-no-token-badge');

    const result = await stub.dispatchPush(
      baseInput({ userId: 'user-no-token-badge', idempotencyKey: 'k-no-token-badge' })
    );

    expect(result.kind).toBe('no_tokens');
    expect(sendPushNotifications).not.toHaveBeenCalled();
    await expect(stub.listNonZeroBuckets()).resolves.toEqual([
      { badgeBucket: 'conv1', badgeCount: 1 },
    ]);
    await expect(stub.markBucketRead('conv1')).resolves.toBe(0);
    await expect(stub.listNonZeroBuckets()).resolves.toEqual([]);
  });

  it('does not send a late push when a no-token dispatch is replayed after token registration', async () => {
    const dbState: DbState = { tokens: [] };
    installDbMock(dbState);
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    const stub = getDO('user-no-token-replay');
    const input = baseInput({
      userId: 'user-no-token-replay',
      idempotencyKey: 'k-no-token-replay',
    });

    const first = await stub.dispatchPush(input);
    dbState.tokens.push({ user_id: 'user-no-token-replay', token: 'tok-after-first-dispatch' });
    const second = await stub.dispatchPush(input);

    expect(first.kind).toBe('no_tokens');
    expect(second.kind).toBe('duplicate');
    expect(sendPushNotifications).not.toHaveBeenCalled();
    await expect(stub.listNonZeroBuckets()).resolves.toEqual([
      { badgeBucket: 'conv1', badgeCount: 1 },
    ]);
  });

  it('delivers and increments badges when presence lookup rejects', async () => {
    installDbMock({ tokens: [{ user_id: 'u', token: 'tok1' }] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockRejectedValueOnce(new Error('rpc down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stub = getDO('user-presence-fail-open');

    try {
      const result = await stub.dispatchPush(
        baseInput({
          userId: 'user-presence-fail-open',
          idempotencyKey: 'k-presence-fail-open',
        })
      );

      expect(result.kind).toBe('delivered');
      expect(warnSpy).toHaveBeenCalledWith(
        'Presence lookup failed while dispatching push; continuing delivery',
        {
          presenceContext: '/presence/kiloclaw/sb1/conv1',
          badgeBucket: 'conv1',
          error: 'rpc down',
        }
      );
      expect(sendPushNotifications).toHaveBeenCalledOnce();
      const stored = await runInDurableObject(stub, async (_inst, state) => ({
        bucket: await state.storage.get<number>('bucket:conv1'),
        total: await state.storage.get<number>('total'),
      }));
      expect(stored).toEqual({ bucket: 1, total: 1 });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('delivers, increments bucket in DO storage, writes idempotency key', async () => {
    installDbMock({ tokens: [{ user_id: 'u', token: 'tok1' }] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValueOnce(false);
    const stub = getDO('user-deliver');

    const result = await stub.dispatchPush(baseInput({ idempotencyKey: 'k-deliver' }));

    expect(result.kind).toBe('delivered');
    expect(sendPushNotifications).toHaveBeenCalledOnce();
    const [[messages]] = vi.mocked(sendPushNotifications).mock.calls;
    expect(messages[0].badge).toBe(1);

    // Bucket persisted to DO storage.
    const stored = await runInDurableObject(stub, async (_inst, state) => ({
      bucket: await state.storage.get<number>('bucket:conv1'),
      total: await state.storage.get<number>('total'),
    }));
    expect(stored).toEqual({ bucket: 1, total: 1 });
  });

  it('does not reread the aggregate total after a non-retry badge increment', async () => {
    installDbMock({ tokens: [{ user_id: 'u', token: 'tok1' }] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValueOnce(false);
    const stub = getDO('user-total-read-once');
    const input = baseInput({
      userId: 'user-total-read-once',
      idempotencyKey: 'k-total-read-once',
    });

    const result = await runInDurableObject(stub, async (instance, state) => {
      const originalGet = state.storage.get.bind(state.storage);
      let totalReads = 0;
      state.storage.get = (<T = unknown>(key: string | string[]) => {
        if (Array.isArray(key)) return originalGet<T>(key);
        if (key === 'total') totalReads++;
        return originalGet<T>(key);
      }) as typeof state.storage.get;

      const outcome = await instance.dispatchPush(input);
      return { outcome, totalReads };
    });

    expect(result.outcome.kind).toBe('delivered');
    expect(result.totalReads).toBe(1);
    const [[messages]] = vi.mocked(sendPushNotifications).mock.calls;
    expect(messages[0].badge).toBe(1);
  });

  it('returns failed and avoids delivered idempotency for non-stale Expo ticket errors', async () => {
    installDbMock({ tokens: [{ user_id: 'u', token: 'tok1' }] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    vi.mocked(sendPushNotifications).mockResolvedValueOnce({
      ticketTokenPairs: [],
      staleTokens: [],
      ticketErrors: [
        {
          errorCode: 'MessageTooBig',
          message: 'Message is too big',
          retryable: false,
        },
      ],
    });
    const stub = getDO('user-ticket-error');

    const result = await stub.dispatchPush(
      baseInput({ userId: 'user-ticket-error', idempotencyKey: 'k-ticket-error' })
    );

    expect(result).toEqual({
      kind: 'failed',
      error: 'Expo rejected 1 push ticket',
    });

    const stored = await runInDurableObject(stub, async (_inst, state) =>
      state.storage.get<{ stage: string; ts: number }>('idem:k-ticket-error')
    );
    expect(stored).toMatchObject({ stage: 'failed' });
  });

  it('treats all-stale Expo ticket results as terminal no-token dispatches', async () => {
    const dbState: DbState = {
      tokens: [
        { user_id: 'user-all-stale', token: 'tok-stale-1' },
        { user_id: 'user-all-stale', token: 'tok-stale-2' },
      ],
      staleTokensToDelete: ['tok-stale-1', 'tok-stale-2'],
    };
    installDbMock(dbState);
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    vi.mocked(sendPushNotifications).mockResolvedValueOnce({
      ticketTokenPairs: [],
      staleTokens: ['tok-stale-1', 'tok-stale-2'],
      ticketErrors: [],
    });
    const receiptSpy = vi.spyOn(env.RECEIPTS_QUEUE, 'send');
    const stub = getDO('user-all-stale');
    const input = baseInput({
      userId: 'user-all-stale',
      idempotencyKey: 'k-all-stale',
    });

    const first = await stub.dispatchPush(input);
    const second = await stub.dispatchPush(input);

    expect(first).toEqual({ kind: 'no_tokens' });
    expect(second).toEqual({ kind: 'duplicate' });
    expect(dbState.tokens).toEqual([]);
    expect(dbState.deleteCalls).toBe(1);
    expect(receiptSpy).not.toHaveBeenCalled();
    await expect(stub.listNonZeroBuckets()).resolves.toEqual([
      { badgeBucket: 'conv1', badgeCount: 1 },
    ]);
    await expect(stub.markBucketRead('conv1')).resolves.toBe(0);

    const stored = await runInDurableObject(stub, async (_inst, state) =>
      state.storage.get<{ stage: string; ts: number }>('idem:k-all-stale')
    );
    expect(stored).toMatchObject({ stage: 'no_tokens' });
  });

  it('reports delivered tokenCount from accepted Expo tickets after stale cleanup', async () => {
    const dbState: DbState = {
      tokens: [
        { user_id: 'user-partial-stale', token: 'tok-accepted' },
        { user_id: 'user-partial-stale', token: 'tok-stale' },
      ],
      staleTokensToDelete: ['tok-stale'],
    };
    installDbMock(dbState);
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    vi.mocked(sendPushNotifications).mockResolvedValueOnce({
      ticketTokenPairs: [{ ticketId: 'ticket-accepted', token: 'tok-accepted' }],
      staleTokens: ['tok-stale'],
      ticketErrors: [],
    });
    const stub = getDO('user-partial-stale');

    const result = await stub.dispatchPush(
      baseInput({
        userId: 'user-partial-stale',
        idempotencyKey: 'k-partial-stale',
      })
    );

    expect(result).toEqual({ kind: 'delivered', tokenCount: 1 });
    expect(dbState.tokens).toEqual([{ user_id: 'user-partial-stale', token: 'tok-accepted' }]);
    expect(dbState.deleteCalls).toBe(1);
  });

  it('terminalizes mixed accepted and retryable ticket errors to avoid resending accepted tokens', async () => {
    installDbMock({
      tokens: [
        { user_id: 'user-partial-ticket-error', token: 'tok-accepted' },
        { user_id: 'user-partial-ticket-error', token: 'tok-rate-limited' },
      ],
    });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    vi.mocked(sendPushNotifications).mockResolvedValueOnce({
      ticketTokenPairs: [{ ticketId: 'ticket-accepted', token: 'tok-accepted' }],
      staleTokens: [],
      ticketErrors: [
        {
          errorCode: 'MessageRateExceeded',
          message: 'Rate limited',
          retryable: true,
        },
      ],
    });
    const receiptSpy = vi.spyOn(env.RECEIPTS_QUEUE, 'send');
    const stub = getDO('user-partial-ticket-error');
    const input = baseInput({
      userId: 'user-partial-ticket-error',
      idempotencyKey: 'k-partial-ticket-error',
    });

    const first = await stub.dispatchPush(input);
    const second = await stub.dispatchPush(input);

    expect(first).toEqual({
      kind: 'failed',
      error: 'Expo rejected 1 push ticket',
    });
    expect(second).toEqual({ kind: 'duplicate' });
    expect(sendPushNotifications).toHaveBeenCalledOnce();
    const [[messages]] = vi.mocked(sendPushNotifications).mock.calls;
    expect(messages.map(message => message.to)).toEqual(['tok-accepted', 'tok-rate-limited']);
    expect(messages.map(message => message.badge)).toEqual([1, 1]);
    expect(receiptSpy).toHaveBeenCalledWith(
      { ticketTokenPairs: [{ ticketId: 'ticket-accepted', token: 'tok-accepted' }] },
      { delaySeconds: 900 }
    );
    await expect(stub.listNonZeroBuckets()).resolves.toEqual([
      { badgeBucket: 'conv1', badgeCount: 1 },
    ]);

    const stored = await runInDurableObject(stub, async (_inst, state) =>
      state.storage.get<{ stage: string; ts: number }>('idem:k-partial-ticket-error')
    );
    expect(stored).toMatchObject({ stage: 'failed' });
  });

  it('keeps retryable-only ticket failures non-terminal for a later retry', async () => {
    installDbMock({ tokens: [{ user_id: 'user-retry-ticket-error', token: 'tok-rate-limited' }] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    vi.mocked(sendPushNotifications).mockResolvedValueOnce({
      ticketTokenPairs: [],
      staleTokens: [],
      ticketErrors: [
        {
          errorCode: 'MessageRateExceeded',
          message: 'Rate limited',
          retryable: true,
        },
      ],
    });
    const stub = getDO('user-retry-ticket-error');
    const input = baseInput({
      userId: 'user-retry-ticket-error',
      idempotencyKey: 'k-retry-ticket-error',
    });

    const first = await stub.dispatchPush(input);
    const second = await stub.dispatchPush(input);

    expect(first).toEqual({
      kind: 'failed',
      error: 'Expo rejected 1 push ticket',
    });
    expect(second).toEqual({ kind: 'delivered', tokenCount: 1 });
    expect(sendPushNotifications).toHaveBeenCalledTimes(2);
    const [firstMessages] = vi.mocked(sendPushNotifications).mock.calls[0];
    const [secondMessages] = vi.mocked(sendPushNotifications).mock.calls[1];
    expect(firstMessages[0].badge).toBe(1);
    expect(secondMessages[0].badge).toBe(1);

    const stored = await runInDurableObject(stub, async (_inst, state) =>
      state.storage.get<{ stage: string; ts: number }>('idem:k-retry-ticket-error')
    );
    expect(stored).toMatchObject({ stage: 'delivered' });
  });

  it('accumulates bucket counts across deliveries and exposes total via badge', async () => {
    installDbMock({ tokens: [{ user_id: 'u', token: 'tok1' }] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    const stub = getDO('user-accumulate');

    await stub.dispatchPush(baseInput({ idempotencyKey: 'k-acc-1' }));
    await stub.dispatchPush(baseInput({ idempotencyKey: 'k-acc-2' }));
    await stub.dispatchPush(
      baseInput({
        idempotencyKey: 'k-acc-3',
        badge: { badgeBucket: 'conv2', delta: 1 },
      })
    );

    const calls = vi.mocked(sendPushNotifications).mock.calls;
    expect(calls[0]?.[0][0].badge).toBe(1);
    expect(calls[1]?.[0][0].badge).toBe(2);
    expect(calls[2]?.[0][0].badge).toBe(3);

    const buckets = await runInDurableObject(stub, async (_inst, state) => {
      const entries = await state.storage.list<number>({ prefix: 'bucket:' });
      return Array.from(entries.entries());
    });
    expect(buckets.sort()).toEqual([
      ['bucket:conv1', 2],
      ['bucket:conv2', 1],
    ]);
  });

  it('returns duplicate when the idempotency key has been seen', async () => {
    installDbMock({ tokens: [{ user_id: 'u', token: 'tok1' }] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    const stub = getDO('user-dup');
    const input = baseInput({ idempotencyKey: 'k-dup' });
    await stub.dispatchPush(input);
    const second = await stub.dispatchPush(input);
    expect(second.kind).toBe('duplicate');
    expect(sendPushNotifications).toHaveBeenCalledOnce();
  });

  it('skips badge mutation when badge is null', async () => {
    installDbMock({ tokens: [{ user_id: 'u', token: 'tok1' }] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValueOnce(false);
    const stub = getDO('user-no-badge');

    const result = await stub.dispatchPush(
      baseInput({ badge: null, idempotencyKey: 'k-no-badge' })
    );

    expect(result.kind).toBe('delivered');
    const [[messages]] = vi.mocked(sendPushNotifications).mock.calls;
    expect(messages[0].badge).toBeUndefined();

    const buckets = await runInDurableObject(stub, async (_inst, state) => {
      const entries = await state.storage.list<number>({ prefix: 'bucket:' });
      return Array.from(entries.keys());
    });
    expect(buckets).toEqual([]);
  });

  it('does not write idempotency key on Expo failure', async () => {
    installDbMock({ tokens: [{ user_id: 'u', token: 'tok1' }] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    vi.mocked(sendPushNotifications).mockRejectedValueOnce(new Error('boom'));
    const stub = getDO('user-fail');
    const input = baseInput({ idempotencyKey: 'k-fail', badge: null });
    const first = await stub.dispatchPush(input);
    expect(first.kind).toBe('failed');
    const second = await stub.dispatchPush(input);
    expect(second.kind).not.toBe('duplicate');
  });

  it('does not re-increment the bucket when retrying after Expo failure', async () => {
    installDbMock({ tokens: [{ user_id: 'u', token: 'tok1' }] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    vi.mocked(sendPushNotifications).mockRejectedValueOnce(new Error('boom'));

    const stub = getDO('user-no-double');
    const input = baseInput({ idempotencyKey: 'k-no-double' });

    const first = await stub.dispatchPush(input);
    expect(first.kind).toBe('failed');

    // After the failed attempt, the bucket has already been incremented once
    // and the idem record is `pending`.
    const afterFail = await runInDurableObject(stub, (_inst, state) =>
      state.storage.get<number>('bucket:conv1')
    );
    expect(afterFail).toBe(1);

    const second = await stub.dispatchPush(input);
    expect(second.kind).toBe('delivered');

    // Bucket must not be incremented twice across the retry — the first
    // attempt's `pending` marker gates the second increment out.
    const afterRetry = await runInDurableObject(stub, (_inst, state) =>
      state.storage.get<number>('bucket:conv1')
    );
    expect(afterRetry).toBe(1);

    const [[messages]] = vi.mocked(sendPushNotifications).mock.calls;
    expect(messages[0].badge).toBe(1);
  });

  it('schedules cleanup when writing the pending marker (failed send)', async () => {
    installDbMock({ tokens: [{ user_id: 'u', token: 'tok1' }] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    vi.mocked(sendPushNotifications).mockRejectedValueOnce(new Error('boom'));
    const stub = getDO('user-pending-alarm');

    const result = await stub.dispatchPush(baseInput({ idempotencyKey: 'k-pending-alarm' }));
    expect(result.kind).toBe('failed');
    // Even though delivery failed, an alarm must be set so the orphan
    // `pending` record gets pruned after IDEM_TTL_MS.
    const alarm = await runInDurableObject(stub, (_inst, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
  });

  it('reschedules cleanup for younger records when alarm fires', async () => {
    installDbMock({ tokens: [{ user_id: 'u', token: 'tok1' }] });
    const stub = getDO('user-reschedule');

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
    installDbMock({ tokens: [{ user_id: 'u', token: 'tok1' }] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    const stub = getDO('user-alarm');

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
