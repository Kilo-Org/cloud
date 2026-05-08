import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type {
  DispatchPushInput,
  PerRecipientResult,
  SendPushForConversationInput,
} from '@kilocode/notifications';

import type * as do_module from '../dos/NotificationChannelDO';
import { sendPushForConversationCore } from '../index';

const baseInput = (
  over: Partial<SendPushForConversationInput> = {}
): SendPushForConversationInput => ({
  conversationId: 'conv1',
  sandboxId: 'sb1',
  senderUserId: 'sender',
  recipientUserIds: ['r1', 'r2', 'r2', 'sender'],
  title: 'Conv Title',
  bodyPreview: 'hello',
  messageId: 'm1',
  ...over,
});

describe('NotificationsService.sendPushForConversation', () => {
  it('excludes sender, dedupes, and routes one DO per recipient userId', async () => {
    const stubSpy = vi.fn(async (_input: DispatchPushInput) => ({
      kind: 'delivered' as const,
      tokenCount: 1,
    }));
    // Spy on idFromName to confirm the DO is keyed by userId, not conversationId.
    const idFromNameSpy = vi.spyOn(env.NOTIFICATION_CHANNEL_DO, 'idFromName');
    vi.spyOn(env.NOTIFICATION_CHANNEL_DO, 'get').mockReturnValue({
      dispatchPush: stubSpy,
    } as unknown as DurableObjectStub<do_module.NotificationChannelDO>);

    const result = await env.SELF.sendPushForConversation(baseInput());

    expect(stubSpy).toHaveBeenCalledTimes(2); // r1, r2
    const idArgs = idFromNameSpy.mock.calls.map(c => c[0]);
    expect(idArgs).toEqual(['r1', 'r2']);
    expect(idArgs).not.toContain('conv1');

    expect(result.perRecipient.map((r: PerRecipientResult) => r.userId).sort()).toEqual([
      'r1',
      'r2',
    ]);
    expect(result.perRecipient.every((r: PerRecipientResult) => r.outcome === 'delivered')).toBe(
      true
    );
  });

  it('passes the right presence context and badge bucket', async () => {
    const stubSpy = vi.fn(async (_input: DispatchPushInput) => ({
      kind: 'delivered' as const,
      tokenCount: 1,
    }));
    vi.spyOn(env.NOTIFICATION_CHANNEL_DO, 'get').mockReturnValue({
      dispatchPush: stubSpy,
    } as unknown as DurableObjectStub<do_module.NotificationChannelDO>);

    await env.SELF.sendPushForConversation(
      baseInput({ recipientUserIds: ['r1'], senderUserId: null })
    );
    const firstCall = stubSpy.mock.calls[0];
    if (!firstCall) throw new Error('expected dispatchPush to be called');
    const call: DispatchPushInput = firstCall[0];
    expect(call.presenceContext).toBe('/presence/kiloclaw/sb1/conv1');
    expect(call.badge).toEqual({ badgeBucket: 'kiloclaw:sb1:conv1', delta: 1 });
    expect(call.push.data).toEqual({
      type: 'chat.message',
      sandboxId: 'sb1',
      conversationId: 'conv1',
      messageId: 'm1',
    });
  });

  it('dispatches recipients in parallel while preserving output order', async () => {
    const dispatches = new Map<
      string,
      (outcome: { kind: 'delivered'; tokenCount: number }) => void
    >();
    const dispatchOrder: string[] = [];
    const resultPromise = sendPushForConversationCore(
      baseInput({ recipientUserIds: ['r1', 'r2', 'r3'], senderUserId: null }),
      {
        getRecipientDOStub: userId => ({
          dispatchPush: async () => {
            dispatchOrder.push(userId);
            return new Promise(resolve => {
              dispatches.set(userId, resolve);
            });
          },
        }),
      }
    );

    await Promise.resolve();

    expect(dispatchOrder).toEqual(['r1', 'r2', 'r3']);

    dispatches.get('r2')?.({ kind: 'delivered', tokenCount: 1 });
    dispatches.get('r1')?.({ kind: 'delivered', tokenCount: 1 });
    dispatches.get('r3')?.({ kind: 'delivered', tokenCount: 1 });

    const result = await resultPromise;
    expect(result.perRecipient).toEqual([
      { userId: 'r1', outcome: 'delivered' },
      { userId: 'r2', outcome: 'delivered' },
      { userId: 'r3', outcome: 'delivered' },
    ]);
  });
});
