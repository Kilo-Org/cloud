import { describe, expect, it } from 'vitest';

import type { ExpoPushMessage, SendResult, TicketTokenPair } from './expo-push';
import {
  buildScheduledActionMessages,
  dispatchScheduledActionPush,
  type ScheduledActionDispatchDeps,
  type SendScheduledActionNoticeParams,
} from './scheduled-action-push';

function baseParams(
  overrides: Partial<SendScheduledActionNoticeParams> = {}
): SendScheduledActionNoticeParams {
  return {
    userId: 'user-1',
    instanceId: 'sandbox-1',
    sandboxId: 'ki_deadbeef',
    event: 'scheduled_restart_notice',
    instanceName: 'My Bot',
    scheduledAt: '2026-05-04T18:55:00Z',
    targetImageTag: null,
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<ScheduledActionDispatchDeps> = {}): {
  deps: ScheduledActionDispatchDeps;
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

  const deps: ScheduledActionDispatchDeps = {
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
        ticketErrors: [],
      } satisfies SendResult;
    },
    enqueueReceipts: async pairs => {
      calls.enqueuedReceipts.push([...pairs]);
    },
    ...overrides,
  };

  return { deps, calls };
}

describe('buildScheduledActionMessages', () => {
  it('builds restart-notice message with instance name and event metadata', () => {
    const params = baseParams({ event: 'scheduled_restart_notice' });
    const messages = buildScheduledActionMessages(['ExponentPushToken[aaa]'], params);

    expect(messages).toHaveLength(1);
    const m = messages[0];
    expect(m.to).toBe('ExponentPushToken[aaa]');
    expect(m.title).toBe('My Bot will restart soon');
    expect(m.body).toContain('Scheduled to restart');
    expect(m.data).toMatchObject({
      type: 'scheduled-action',
      event: 'scheduled_restart_notice',
      sandboxId: 'ki_deadbeef',
    });
    expect(m.sound).toBe('default');
    expect(m.priority).toBe('high');
  });

  it('falls back to "KiloClaw" when instanceName is null', () => {
    const messages = buildScheduledActionMessages(
      ['ExponentPushToken[aaa]'],
      baseParams({ instanceName: null })
    );
    expect(messages[0].title).toBe('KiloClaw will restart soon');
  });

  it('builds version-change-notice with the target tag in body when set', () => {
    const messages = buildScheduledActionMessages(
      ['ExponentPushToken[aaa]'],
      baseParams({
        event: 'scheduled_version_change_notice',
        targetImageTag: 'dev-1234567',
      })
    );
    expect(messages[0].title).toBe('My Bot will upgrade soon');
    expect(messages[0].body).toContain('dev-1234567');
  });

  it('builds version-change-notice without tag falls back to generic phrasing', () => {
    const messages = buildScheduledActionMessages(
      ['ExponentPushToken[aaa]'],
      baseParams({
        event: 'scheduled_version_change_notice',
        targetImageTag: null,
      })
    );
    expect(messages[0].body).not.toContain('null');
    expect(messages[0].body).toContain('Scheduled upgrade');
  });

  it('builds restart-cancelled message', () => {
    const messages = buildScheduledActionMessages(
      ['ExponentPushToken[aaa]'],
      baseParams({ event: 'scheduled_restart_cancelled' })
    );
    expect(messages[0].title).toBe('My Bot restart cancelled');
    expect(messages[0].body).toContain('cancelled');
  });

  it('builds version-change-cancelled message', () => {
    const messages = buildScheduledActionMessages(
      ['ExponentPushToken[aaa]'],
      baseParams({ event: 'scheduled_version_change_cancelled' })
    );
    expect(messages[0].title).toBe('My Bot upgrade cancelled');
    expect(messages[0].body).toContain('cancelled');
  });

  it('emits one message per token', () => {
    const messages = buildScheduledActionMessages(
      ['ExponentPushToken[aaa]', 'ExponentPushToken[bbb]', 'ExponentPushToken[ccc]'],
      baseParams()
    );
    expect(messages).toHaveLength(3);
    expect(messages.map(m => m.to)).toEqual([
      'ExponentPushToken[aaa]',
      'ExponentPushToken[bbb]',
      'ExponentPushToken[ccc]',
    ]);
  });
});

describe('dispatchScheduledActionPush', () => {
  it('returns zero counts and skips downstream calls when the user has no tokens', async () => {
    const { deps, calls } = fakeDeps({ getTokens: async () => [] });
    const result = await dispatchScheduledActionPush(baseParams(), deps);

    expect(result).toEqual({
      tokenCount: 0,
      sent: 0,
      staleTokens: 0,
      receiptCount: 0,
    });
    expect(calls.sentMessages).toHaveLength(0);
    expect(calls.deletedTokens).toHaveLength(0);
    expect(calls.enqueuedReceipts).toHaveLength(0);
  });

  it('sends per-token messages and enqueues receipts on the happy path', async () => {
    const { deps, calls } = fakeDeps();
    const result = await dispatchScheduledActionPush(baseParams(), deps);

    expect(result.tokenCount).toBe(2);
    expect(result.sent).toBe(2);
    expect(result.staleTokens).toBe(0);
    expect(result.receiptCount).toBe(2);
    expect(calls.sentMessages).toHaveLength(1);
    expect(calls.sentMessages[0]).toHaveLength(2);
    expect(calls.enqueuedReceipts[0].map(p => p.ticketId)).toEqual(['t-0', 't-1']);
  });

  it('deletes stale tokens reported by the push provider', async () => {
    const { deps, calls } = fakeDeps({
      sendPush: async () => ({
        ticketTokenPairs: [{ ticketId: 't-0', token: 'ExponentPushToken[aaa]' }],
        staleTokens: ['ExponentPushToken[bbb]'],
        ticketErrors: [],
      }),
    });
    const result = await dispatchScheduledActionPush(baseParams(), deps);

    expect(result.staleTokens).toBe(1);
    expect(calls.deletedTokens).toEqual([['ExponentPushToken[bbb]']]);
  });

  it('skips enqueueReceipts when no tickets returned', async () => {
    const { deps, calls } = fakeDeps({
      sendPush: async () => ({ ticketTokenPairs: [], staleTokens: [], ticketErrors: [] }),
    });
    await dispatchScheduledActionPush(baseParams(), deps);

    expect(calls.enqueuedReceipts).toHaveLength(0);
  });
});
