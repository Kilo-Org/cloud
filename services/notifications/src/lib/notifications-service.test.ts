import { describe, expect, it } from 'vitest';

import type { ExpoPushMessage, SendResult, TicketTokenPair } from './expo-push';
import {
  buildInstanceLifecycleMessages,
  dispatchInstanceLifecyclePush,
  type LifecycleDispatchDeps,
  type SendInstanceLifecycleNotificationParams,
} from './instance-lifecycle-push';

function baseParams(
  overrides: Partial<SendInstanceLifecycleNotificationParams> = {}
): SendInstanceLifecycleNotificationParams {
  return {
    userId: 'user-1',
    instanceId: 'sandbox-1',
    sandboxId: 'ki_deadbeef',
    event: 'ready',
    instanceName: 'My Bot',
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<LifecycleDispatchDeps> = {}): {
  deps: LifecycleDispatchDeps;
  calls: {
    sentMessages: ExpoPushMessage[][];
    deletedTokens: string[][];
    enqueuedReceipts: TicketTokenPair[][];
    getTokenQueries: string[];
  };
} {
  const calls = {
    sentMessages: [] as ExpoPushMessage[][],
    deletedTokens: [] as string[][],
    enqueuedReceipts: [] as TicketTokenPair[][],
    getTokenQueries: [] as string[],
  };

  const deps: LifecycleDispatchDeps = {
    getTokens: async userId => {
      calls.getTokenQueries.push(userId);
      return ['ExponentPushToken[aaa]', 'ExponentPushToken[bbb]'];
    },
    deleteStaleTokens: async tokens => {
      calls.deletedTokens.push([...tokens]);
    },
    sendPush: async messages => {
      calls.sentMessages.push(messages);
      return {
        ticketTokenPairs: messages.map((m, i) => ({
          ticketId: `t-${i}`,
          token: typeof m.to === 'string' ? m.to : m.to[0],
        })),
        staleTokens: [],
      } satisfies SendResult;
    },
    enqueueReceipts: async pairs => {
      calls.enqueuedReceipts.push([...pairs]);
    },
    ...overrides,
  };

  return { deps, calls };
}

describe('buildInstanceLifecycleMessages', () => {
  it('builds ready message with instance name and chat deep-link data', () => {
    const messages = buildInstanceLifecycleMessages(
      ['ExponentPushToken[aaa]'],
      baseParams({ event: 'ready', instanceName: 'My Bot' })
    );
    expect(messages).toHaveLength(1);
    const m = messages[0];
    expect(m.to).toBe('ExponentPushToken[aaa]');
    expect(m.title).toBe('My Bot is ready');
    expect(m.body).toBe('Tap to start chatting.');
    expect(m.data).toEqual({
      type: 'instance-lifecycle',
      event: 'ready',
      instanceId: 'sandbox-1',
    });
    expect(m.sound).toBe('default');
    expect(m.priority).toBe('high');
    // Lifecycle pushes do not increment the chat unread counter.
    expect((m as { badge?: number }).badge).toBeUndefined();
  });

  it('falls back to "KiloClaw" when instanceName is null', () => {
    const [m] = buildInstanceLifecycleMessages(
      ['t'],
      baseParams({ event: 'ready', instanceName: null })
    );
    expect(m.title).toBe('KiloClaw is ready');
  });

  it('builds start_failed message with provided errorMessage', () => {
    const [m] = buildInstanceLifecycleMessages(
      ['t'],
      baseParams({
        event: 'start_failed',
        instanceName: 'My Bot',
        errorMessage: 'The machine entered a failed state.',
      })
    );
    expect(m.title).toBe('My Bot failed to start');
    expect(m.body).toBe('The machine entered a failed state.');
    expect((m.data as { event: string }).event).toBe('start_failed');
  });

  it('truncates errorMessage beyond 100 chars', () => {
    const long = 'x'.repeat(150);
    const [m] = buildInstanceLifecycleMessages(
      ['t'],
      baseParams({ event: 'start_failed', errorMessage: long })
    );
    expect(m.body?.length).toBe(100);
    expect(m.body?.endsWith('...')).toBe(true);
  });

  it('uses a fallback body when start_failed has no errorMessage', () => {
    const [m] = buildInstanceLifecycleMessages(
      ['t'],
      baseParams({ event: 'start_failed', errorMessage: undefined })
    );
    expect(m.body).toBe('Start failed.');
  });

  it('emits one message per token', () => {
    const messages = buildInstanceLifecycleMessages(['a', 'b', 'c'], baseParams());
    expect(messages.map(m => m.to)).toEqual(['a', 'b', 'c']);
  });
});

describe('dispatchInstanceLifecyclePush', () => {
  it('sends one push per registered token and enqueues receipt check', async () => {
    const { deps, calls } = fakeDeps();

    const result = await dispatchInstanceLifecyclePush(baseParams(), deps);

    expect(result).toEqual({ tokenCount: 2, sent: 2, staleTokens: 0, receiptCount: 2 });
    expect(calls.getTokenQueries).toEqual(['user-1']);
    expect(calls.sentMessages).toHaveLength(1);
    expect(calls.sentMessages[0]).toHaveLength(2);
    expect(calls.enqueuedReceipts).toHaveLength(1);
    expect(calls.enqueuedReceipts[0]).toHaveLength(2);
    expect(calls.deletedTokens).toHaveLength(0);
  });

  it('no-ops and returns zero counts when the user has no tokens', async () => {
    const { deps, calls } = fakeDeps({
      getTokens: async () => [],
    });

    const result = await dispatchInstanceLifecyclePush(baseParams(), deps);

    expect(result).toEqual({ tokenCount: 0, sent: 0, staleTokens: 0, receiptCount: 0 });
    expect(calls.sentMessages).toHaveLength(0);
    expect(calls.enqueuedReceipts).toHaveLength(0);
    expect(calls.deletedTokens).toHaveLength(0);
  });

  it('deletes stale tokens reported by Expo', async () => {
    const { deps, calls } = fakeDeps({
      sendPush: async messages => ({
        ticketTokenPairs: [
          {
            ticketId: 't-0',
            token: typeof messages[0].to === 'string' ? messages[0].to : messages[0].to[0],
          },
        ],
        staleTokens: ['ExponentPushToken[bbb]'],
      }),
    });

    const result = await dispatchInstanceLifecyclePush(baseParams(), deps);

    expect(result).toEqual({ tokenCount: 2, sent: 1, staleTokens: 1, receiptCount: 1 });
    expect(calls.deletedTokens).toEqual([['ExponentPushToken[bbb]']]);
  });

  it('skips receipt enqueue when every ticket was a failure', async () => {
    const { deps, calls } = fakeDeps({
      sendPush: async () => ({
        ticketTokenPairs: [],
        staleTokens: ['ExponentPushToken[aaa]', 'ExponentPushToken[bbb]'],
      }),
    });

    const result = await dispatchInstanceLifecyclePush(baseParams(), deps);

    expect(result).toEqual({ tokenCount: 2, sent: 0, staleTokens: 2, receiptCount: 0 });
    expect(calls.deletedTokens).toEqual([['ExponentPushToken[aaa]', 'ExponentPushToken[bbb]']]);
    expect(calls.enqueuedReceipts).toHaveLength(0);
  });

  it('rejects invalid params via zod before doing any IO', async () => {
    const { deps, calls } = fakeDeps();

    await expect(
      dispatchInstanceLifecyclePush({ ...baseParams(), userId: '' }, deps)
    ).rejects.toThrow();

    expect(calls.getTokenQueries).toHaveLength(0);
    expect(calls.sentMessages).toHaveLength(0);
  });

  it('carries the chat route id through to the Expo data payload', async () => {
    const { deps, calls } = fakeDeps();

    await dispatchInstanceLifecyclePush(baseParams({ instanceId: 'ki_deadbeef' }), deps);

    const sent = calls.sentMessages[0];
    expect((sent[0].data as { instanceId: string }).instanceId).toBe('ki_deadbeef');
  });
});
