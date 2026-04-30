import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type {
  DispatchPushInput,
  PerRecipientResult,
  SendPushForConversationInput,
} from '@kilocode/notifications';

import type * as do_module from '../dos/NotificationChannelDO';

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
  it('excludes sender, dedupes, fans out to remaining recipients', async () => {
    const stubSpy = vi.fn(async (_input: DispatchPushInput) => ({
      kind: 'delivered' as const,
      tokenCount: 1,
    }));
    vi.spyOn(env.NOTIFICATION_CHANNEL_DO, 'get').mockReturnValue({
      dispatchPush: stubSpy,
    } as unknown as DurableObjectStub<do_module.NotificationChannelDO>);

    const result = await env.SELF.sendPushForConversation(baseInput());

    expect(stubSpy).toHaveBeenCalledTimes(2); // r1, r2
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
});
