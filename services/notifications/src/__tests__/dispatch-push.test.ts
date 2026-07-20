import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import type { DispatchPushInput } from '@kilocode/notifications';

import { sendPushNotifications } from '../lib/expo-push';
import { setPushSinkModeForTesting } from '../lib/push-sink';
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

  it('skips presence lookup when presence suppression is explicitly disabled', async () => {
    installDbMock({ tokens: [] });
    const presenceSpy = vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValueOnce(false);
    const result = await getDO('user-no-presence-context').dispatchPush(
      baseInput({
        userId: 'user-no-presence-context',
        presenceContext: null,
        idempotencyKey: 'k-no-presence-context',
      })
    );
    expect(result.kind).toBe('no_tokens');
    expect(presenceSpy).not.toHaveBeenCalled();
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

  it('keeps an unclassified empty Expo result retryable when push tokens exist', async () => {
    installDbMock({ tokens: [{ user_id: 'user-empty-expo-result', token: 'tok1' }] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    vi.mocked(sendPushNotifications).mockResolvedValueOnce({
      ticketTokenPairs: [],
      staleTokens: [],
      ticketErrors: [],
    });
    const stub = getDO('user-empty-expo-result');
    const input = baseInput({
      userId: 'user-empty-expo-result',
      badge: null,
      idempotencyKey: 'k-empty-expo-result',
    });

    const first = await stub.dispatchPush(input);
    const storedAfterFirst = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<{ stage: string; ts: number }>('idem:k-empty-expo-result')
    );
    const second = await stub.dispatchPush(input);

    expect(first.kind).toBe('failed');
    expect(storedAfterFirst).toBeUndefined();
    expect(second).toEqual({ kind: 'delivered', tokenCount: 1 });
    expect(sendPushNotifications).toHaveBeenCalledTimes(2);
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

  it('retries receipt bookkeeping without resending an accepted badge-less push', async () => {
    installDbMock({ tokens: [{ user_id: 'user-receipt-retry', token: 'tok1' }] });
    const receiptSpy = vi
      .spyOn(env.RECEIPTS_QUEUE, 'send')
      .mockRejectedValueOnce(new Error('receipt queue unavailable'))
      .mockResolvedValueOnce(undefined);
    const stub = getDO('user-receipt-retry');
    const input = baseInput({
      userId: 'user-receipt-retry',
      badge: null,
      idempotencyKey: 'k-receipt-retry',
    });

    const firstResult = await stub.dispatchPush(input);
    const retryResult = await stub.dispatchPush(input);

    expect(firstResult).toEqual({
      kind: 'failed',
      error: 'Accepted push bookkeeping failed: receipt queue unavailable',
    });
    expect(retryResult).toEqual({ kind: 'duplicate' });
    expect(sendPushNotifications).toHaveBeenCalledOnce();
    expect(receiptSpy).toHaveBeenCalledTimes(2);
  });

  it('repairs accepted push bookkeeping from the cleanup alarm without resending', async () => {
    installDbMock({ tokens: [{ user_id: 'user-alarm-repair', token: 'tok1' }] });
    const receiptSpy = vi
      .spyOn(env.RECEIPTS_QUEUE, 'send')
      .mockRejectedValueOnce(new Error('receipt queue unavailable'))
      .mockResolvedValueOnce(undefined);
    const stub = getDO('user-alarm-repair');

    const firstResult = await stub.dispatchPush(
      baseInput({
        userId: 'user-alarm-repair',
        badge: null,
        idempotencyKey: 'k-alarm-repair',
      })
    );
    const scheduledAlarm = await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm()
    );
    expect(scheduledAlarm).not.toBeNull();
    expect(scheduledAlarm ?? Infinity).toBeLessThan(Date.now() + 60_000);

    await runInDurableObject(stub, async instance => {
      await (instance as unknown as { alarm: () => Promise<void> }).alarm();
    });

    expect(firstResult.kind).toBe('failed');
    expect(sendPushNotifications).toHaveBeenCalledOnce();
    expect(receiptSpy).toHaveBeenCalledTimes(2);
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<{ stage: string; ts: number }>('idem:k-alarm-repair')
    );
    expect(stored).toMatchObject({ stage: 'delivered' });
  });

  it('continues accepted push bookkeeping when initial alarm scheduling fails', async () => {
    installDbMock({ tokens: [{ user_id: 'user-alarm-setup-fail', token: 'tok1' }] });
    const receiptSpy = vi.spyOn(env.RECEIPTS_QUEUE, 'send');
    const stub = getDO('user-alarm-setup-fail');

    const result = await runInDurableObject(stub, async (instance, state) => {
      const originalSetAlarm = state.storage.setAlarm.bind(state.storage);
      vi.spyOn(state.storage, 'setAlarm')
        .mockRejectedValueOnce(new Error('alarm unavailable'))
        .mockImplementation(originalSetAlarm);

      return instance.dispatchPush(
        baseInput({
          userId: 'user-alarm-setup-fail',
          badge: null,
          idempotencyKey: 'k-alarm-setup-fail',
        })
      );
    });

    expect(result).toEqual({ kind: 'delivered', tokenCount: 1 });
    expect(sendPushNotifications).toHaveBeenCalledOnce();
    expect(receiptSpy).toHaveBeenCalledOnce();
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<{ stage: string; ts: number }>('idem:k-alarm-setup-fail')
    );
    expect(stored).toMatchObject({ stage: 'delivered' });
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

describe('NotificationChannelDO.dispatchPush — agent rate limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(env.EXPO_ACCESS_TOKEN, 'get').mockResolvedValue('test-token');
    setPushSinkModeForTesting(undefined);
  });

  afterEach(() => {
    setPushSinkModeForTesting(undefined);
  });

  const agentInput = (
    over: Partial<DispatchPushInput> = {},
    idemSuffix = ''
  ): DispatchPushInput => ({
    userId: 'user-rl',
    presenceContext: null,
    idempotencyKey: `agent-notification:ses_xyz:n${idemSuffix}`,
    badge: null,
    push: {
      title: 'T',
      body: 'B',
      data: { type: 'cloud_agent_session', cliSessionId: 'ses_xyz' },
      sound: 'default',
      priority: 'high',
    },
    rateLimit: { key: 'agent:ses_xyz', limit: 5, windowSeconds: 600 },
    ...over,
  });

  it('allows 5 attempts and suppresses the 6th within the window', async () => {
    installDbMock({ tokens: [{ user_id: 'user-rl', token: 'tok1' }] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    const stub = getDO('user-rl-window');

    for (let i = 1; i <= 5; i++) {
      const result = await stub.dispatchPush(agentInput({}, String(i)));
      expect(result.kind).toBe('delivered');
    }
    const sixth = await stub.dispatchPush(agentInput({}, '6'));
    expect(sixth.kind).toBe('suppressed_rate_limit');
    expect(sendPushNotifications).toHaveBeenCalledTimes(5);
  });

  it('prunes timestamps older than the window and re-allows attempts', async () => {
    installDbMock({ tokens: [{ user_id: 'user-rl-prune', token: 'tok1' }] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    const stub = getDO('user-rl-prune');

    const realNow = Date.now;
    try {
      // Fill the 5-slot window at t=0.
      for (let i = 1; i <= 5; i++) {
        const result = await stub.dispatchPush(agentInput({}, String(i)));
        expect(result.kind).toBe('delivered');
      }
      const sixth = await stub.dispatchPush(agentInput({}, '6'));
      expect(sixth.kind).toBe('suppressed_rate_limit');

      // Jump past the 600s window. Prune-on-read should re-allow the next
      // attempt without needing the alarm GC sweep to have fired.
      vi.spyOn(Date, 'now').mockImplementation(() => realNow.call(Date) + 601 * 1000);
      const afterWindow = await stub.dispatchPush(agentInput({}, '7'));
      expect(afterWindow.kind).toBe('delivered');
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
  });

  it('records the idempotency key with suppressed_rate_limit so replays dedup', async () => {
    installDbMock({ tokens: [{ user_id: 'user-rl-dedup', token: 'tok1' }] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    const stub = getDO('user-rl-dedup');
    const input = agentInput({}, 'rl-dedup');

    for (let i = 1; i <= 5; i++) {
      await stub.dispatchPush(agentInput({}, `filler-${i}`));
    }
    const first = await stub.dispatchPush(input);
    expect(first.kind).toBe('suppressed_rate_limit');
    const replay = await stub.dispatchPush(input);
    expect(replay.kind).toBe('duplicate');
    expect(sendPushNotifications).toHaveBeenCalledTimes(5);

    const stored = await runInDurableObject(stub, (_inst, state) =>
      state.storage.get<{ stage: string; ts: number }>('idem:agent-notification:ses_xyz:nrl-dedup')
    );
    expect(stored).toMatchObject({ stage: 'suppressed_rate_limit' });
  });

  it('a duplicate attempt does not consume rate-limit quota', async () => {
    installDbMock({ tokens: [{ user_id: 'user-rl-dup', token: 'tok1' }] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    const stub = getDO('user-rl-dup');
    const input = agentInput({}, 'dup');

    const first = await stub.dispatchPush(input);
    expect(first.kind).toBe('delivered');
    const replay = await stub.dispatchPush(input);
    expect(replay.kind).toBe('duplicate');

    // 4 more distinct attempts should still fit; the 6th is suppressed.
    for (let i = 1; i <= 4; i++) {
      const result = await stub.dispatchPush(agentInput({}, `extra-${i}`));
      expect(result.kind).toBe('delivered');
    }
    const sixth = await stub.dispatchPush(agentInput({}, 'sixth'));
    expect(sixth.kind).toBe('suppressed_rate_limit');
  });

  it('does not re-consume a rate-limit slot when retrying a failed no-badge agent notification', async () => {
    installDbMock({ tokens: [{ user_id: 'user-rl', token: 'tok1' }] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    vi.mocked(sendPushNotifications).mockRejectedValueOnce(new Error('send failed'));
    const stub = getDO('user-rl-retry');
    const input = agentInput({}, 'retry');

    const first = await stub.dispatchPush(input);
    expect(first.kind).toBe('failed');

    // The failed attempt should have left the idempotency key as `pending`
    // and consumed exactly one rate-limit slot.
    const storedAfterFirst = await runInDurableObject(stub, async (_inst, state) => ({
      idem: await state.storage.get<{ stage: string }>(`idem:${input.idempotencyKey}`),
      rl: await state.storage.get<{ timestamps: number[] }>(`rl:${input.rateLimit?.key}`),
    }));
    expect(storedAfterFirst.idem).toMatchObject({ stage: 'pending' });
    expect(storedAfterFirst.rl?.timestamps).toHaveLength(1);

    const retry = await stub.dispatchPush(input);
    expect(retry.kind).toBe('delivered');

    // The retry should not have consumed another slot.
    const rlAfterRetry = await runInDurableObject(stub, async (_inst, state) =>
      state.storage.get<{ timestamps: number[] }>(`rl:${input.rateLimit?.key}`)
    );
    expect(rlAfterRetry?.timestamps).toHaveLength(1);

    // A fresh notification id for the same session window should consume.
    const fresh = await stub.dispatchPush(agentInput({}, 'fresh'));
    expect(fresh.kind).toBe('delivered');
    const rlAfterFresh = await runInDurableObject(stub, async (_inst, state) =>
      state.storage.get<{ timestamps: number[] }>(`rl:${input.rateLimit?.key}`)
    );
    expect(rlAfterFresh?.timestamps).toHaveLength(2);
  });

  it('a presence-suppressed attempt does not consume rate-limit quota', async () => {
    installDbMock({ tokens: [{ user_id: 'user-rl-pres', token: 'tok1' }] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValueOnce(true);
    const stub = getDO('user-rl-pres');
    const presInput = {
      ...agentInput({}, 'pres'),
      presenceContext: '/presence/cli-session/ses_xyz',
    };

    const first = await stub.dispatchPush(presInput);
    expect(first.kind).toBe('suppressed_presence');

    // 5 more attempts that bypass presence should all be allowed; the
    // presence-suppressed attempt never consumed quota.
    for (let i = 1; i <= 5; i++) {
      const result = await stub.dispatchPush(agentInput({}, `npr-${i}`));
      expect(result.kind).toBe('delivered');
    }
    expect(sendPushNotifications).toHaveBeenCalledTimes(5);
  });

  it('writing an rl: record ensures a cleanup alarm exists and reschedules while unexpired', async () => {
    installDbMock({ tokens: [{ user_id: 'user-rl-alarm', token: 'tok1' }] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    const stub = getDO('user-rl-alarm');

    const firstAlarmBefore = await runInDurableObject(stub, (_inst, state) =>
      state.storage.getAlarm()
    );
    expect(firstAlarmBefore).toBeNull();

    await stub.dispatchPush(agentInput({}, '1'));
    const firstAlarm = await runInDurableObject(stub, (_inst, state) => state.storage.getAlarm());
    expect(firstAlarm).not.toBeNull();

    // Subsequent writes inside the window must not advance the alarm.
    const realNow = Date.now;
    try {
      vi.spyOn(Date, 'now').mockImplementation(() => realNow.call(Date) + 60_000);
      await stub.dispatchPush(agentInput({}, '2'));
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
    const secondAlarm = await runInDurableObject(stub, (_inst, state) => state.storage.getAlarm());
    expect(secondAlarm).toBe(firstAlarm);
  });

  it('the alarm GC sweep deletes expired rl: records and reschedules for the earliest unexpired one', async () => {
    const stub = getDO('user-rl-gc');
    const now = Date.now();

    await runInDurableObject(stub, async (_inst, state) => {
      // Expired rl record (expiresAt in the past)
      await state.storage.put('rl:agent:ses_old', {
        expiresAt: now - 1_000,
        timestamps: [now - 700_000],
      });
      // Unexpired rl record (expiresAt in the future)
      await state.storage.put('rl:agent:ses_fresh', {
        expiresAt: now + 60_000,
        timestamps: [now],
      });
      // Expired idem record to confirm GC still touches it
      await state.storage.put('idem:old', { stage: 'delivered', ts: now - 2 * 60 * 60 * 1000 });
    });

    await runInDurableObject(stub, async inst => {
      await (inst as unknown as { alarm: () => Promise<void> }).alarm();
    });

    const remaining = await runInDurableObject(stub, async (_inst, state) => {
      const rl = await state.storage.list({ prefix: 'rl:' });
      const idem = await state.storage.list({ prefix: 'idem:' });
      return { rlKeys: Array.from(rl.keys()), idemKeys: Array.from(idem.keys()) };
    });
    expect(remaining.rlKeys).toEqual(['rl:agent:ses_fresh']);
    expect(remaining.idemKeys).toEqual([]);

    const alarm = await runInDurableObject(stub, (_inst, state) => state.storage.getAlarm());
    expect(alarm).toBe(now + 60_000);
  });

  it('skips the rate-limit check entirely when no rateLimit is set on the input', async () => {
    installDbMock({ tokens: [{ user_id: 'user-no-rl', token: 'tok1' }] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    const stub = getDO('user-no-rl');
    const input = baseInput({ userId: 'user-no-rl', idempotencyKey: 'no-rl-1' });
    delete (input as Partial<DispatchPushInput>).rateLimit;

    for (let i = 0; i < 6; i++) {
      const result = await stub.dispatchPush({ ...input, idempotencyKey: `no-rl-${i + 1}` });
      expect(result.kind).toBe('delivered');
    }
    expect(sendPushNotifications).toHaveBeenCalledTimes(6);
  });
});

describe('NotificationChannelDO.dispatchPush — local push sink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(env.EXPO_ACCESS_TOKEN, 'get').mockResolvedValue('test-token');
  });

  afterEach(() => {
    setPushSinkModeForTesting(undefined);
  });

  it('is off by default (PUSH_SINK_MODE unset) and calls the real Expo path', async () => {
    setPushSinkModeForTesting(undefined);
    installDbMock({ tokens: [{ user_id: 'user-sink-off', token: 'tok1' }] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    const stub = getDO('user-sink-off');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await stub.dispatchPush(
      baseInput({ userId: 'user-sink-off', idempotencyKey: 'sink-off-1' })
    );
    expect(result.kind).toBe('delivered');
    expect(sendPushNotifications).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls.some(call => call[0] === 'agent_push_sink_payload')).toBe(false);
    logSpy.mockRestore();
  });

  it('in sink mode, records the redacted payload, returns delivered, and skips Expo entirely', async () => {
    setPushSinkModeForTesting('log');
    installDbMock({ tokens: [{ user_id: 'user-sink-on', token: 'tok-real' }] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    const stub = getDO('user-sink-on');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const idemKey = 'agent-notification:ses_sink:n-sink-1';

    const result = await stub.dispatchPush({
      userId: 'user-sink-on',
      presenceContext: null,
      idempotencyKey: idemKey,
      badge: null,
      push: {
        title: 'My title',
        body: 'My body',
        data: { type: 'cloud_agent_session', cliSessionId: 'ses_sink' },
        sound: 'default',
        priority: 'high',
      },
    });

    expect(result.kind).toBe('delivered');
    expect(sendPushNotifications).not.toHaveBeenCalled();

    const sinkCall = logSpy.mock.calls.find(call => call[0] === 'agent_push_sink_payload');
    expect(sinkCall).toBeDefined();
    const payload = sinkCall?.[1] as {
      idempotencyKey: string;
      payload: {
        title: string;
        body: string;
        data: unknown;
        sound: string | null;
        priority: string;
      };
      to: string;
    };
    expect(payload.idempotencyKey).toBe(idemKey);
    expect(payload.payload).toEqual({
      title: 'My title',
      body: 'My body',
      data: { type: 'cloud_agent_session', cliSessionId: 'ses_sink' },
      sound: 'default',
      priority: 'high',
    });
    expect(payload.to).toBe('<redacted>');
    // Token must never appear in the sink payload.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('tok-real');
    expect(serialized).not.toContain('ExponentPushToken');

    // No receipt work created.
    expect(env.RECEIPTS_QUEUE.send).not.toHaveBeenCalled();

    // Terminal `delivered` idem state + cleanup alarm scheduled.
    const stored = await runInDurableObject(stub, (_inst, state) =>
      state.storage.get<{ stage: string; ts: number }>(`idem:${idemKey}`)
    );
    expect(stored).toMatchObject({ stage: 'delivered' });
    const alarm = await runInDurableObject(stub, (_inst, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();

    logSpy.mockRestore();
  });

  it('in sink mode with no tokens, returns no_tokens and does not reach the sink', async () => {
    setPushSinkModeForTesting('log');
    installDbMock({ tokens: [] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    const stub = getDO('user-sink-no-tokens');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const idemKey = 'agent-notification:ses_no_tokens:n-1';

    const result = await stub.dispatchPush({
      userId: 'user-sink-no-tokens',
      presenceContext: null,
      idempotencyKey: idemKey,
      badge: null,
      push: {
        title: 'T',
        body: 'B',
        data: { type: 'cloud_agent_session', cliSessionId: 'ses_no_tokens' },
        sound: 'default',
        priority: 'high',
      },
    });

    expect(result.kind).toBe('no_tokens');
    expect(logSpy.mock.calls.some(call => call[0] === 'agent_push_sink_payload')).toBe(false);
    expect(sendPushNotifications).not.toHaveBeenCalled();

    const stored = await runInDurableObject(stub, (_inst, state) =>
      state.storage.get<{ stage: string; ts: number }>(`idem:${idemKey}`)
    );
    expect(stored).toMatchObject({ stage: 'no_tokens' });

    logSpy.mockRestore();
  });

  it('in sink mode, replays return duplicate (terminal state)', async () => {
    setPushSinkModeForTesting('log');
    installDbMock({ tokens: [{ user_id: 'user-sink-replay', token: 'tok1' }] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValue(false);
    const stub = getDO('user-sink-replay');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const input: DispatchPushInput = {
      userId: 'user-sink-replay',
      presenceContext: null,
      idempotencyKey: 'agent-notification:ses_replay:n-1',
      badge: null,
      push: {
        title: 'T',
        body: 'B',
        data: { type: 'cloud_agent_session', cliSessionId: 'ses_replay' },
        sound: 'default',
        priority: 'high',
      },
    };
    const first = await stub.dispatchPush(input);
    expect(first.kind).toBe('delivered');
    const replay = await stub.dispatchPush(input);
    expect(replay.kind).toBe('duplicate');
    logSpy.mockRestore();
  });

  it('presence suppression still applies in sink mode', async () => {
    setPushSinkModeForTesting('log');
    installDbMock({ tokens: [{ user_id: 'user-sink-pres', token: 'tok1' }] });
    vi.spyOn(env.EVENT_SERVICE, 'isUserInContext').mockResolvedValueOnce(true);
    const stub = getDO('user-sink-pres');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await stub.dispatchPush({
      userId: 'user-sink-pres',
      presenceContext: '/presence/cli-session/ses_pres',
      idempotencyKey: 'agent-notification:ses_pres:n-1',
      badge: null,
      push: {
        title: 'T',
        body: 'B',
        data: { type: 'cloud_agent_session', cliSessionId: 'ses_pres' },
        sound: 'default',
        priority: 'high',
      },
    });
    expect(result.kind).toBe('suppressed_presence');
    expect(logSpy.mock.calls.some(call => call[0] === 'agent_push_sink_payload')).toBe(false);
    logSpy.mockRestore();
  });
});
