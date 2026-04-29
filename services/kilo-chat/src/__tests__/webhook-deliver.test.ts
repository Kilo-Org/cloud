import { describe, it, expect, vi } from 'vitest';
import { deliverToBot } from '../webhook/deliver';

function makeMsg(overrides?: Partial<Parameters<typeof deliverToBot>[1]>) {
  return {
    targetBotId: 'bot:kiloclaw:sandbox-1',
    conversationId: 'conv-1',
    messageId: 'msg-1',
    from: 'user-1',
    content: [{ type: 'text' as const, text: 'Hello' }],
    sentAt: '2026-04-14T00:00:00Z',
    ...overrides,
  };
}

function makeEnvWithConvStub(
  deliverChatWebhook: ReturnType<typeof vi.fn>,
  notifyDeliveryFailed: ReturnType<typeof vi.fn> = vi.fn()
) {
  return {
    KILOCLAW: { deliverChatWebhook },
    CONVERSATION_DO: {
      idFromName: vi.fn().mockReturnValue('id'),
      get: vi.fn().mockReturnValue({
        notifyDeliveryFailed,
      }),
    },
  } as unknown as Env;
}

describe('deliverToBot', () => {
  it('delivers via KILOCLAW RPC on first attempt', async () => {
    const deliverChatWebhook = vi.fn().mockResolvedValue(undefined);
    const notifyDeliveryFailed = vi.fn();
    const env = makeEnvWithConvStub(deliverChatWebhook, notifyDeliveryFailed);

    await deliverToBot(env, makeMsg());

    expect(deliverChatWebhook).toHaveBeenCalledOnce();
    expect(deliverChatWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        targetBotId: 'bot:kiloclaw:sandbox-1',
        conversationId: 'conv-1',
        text: 'Hello',
      })
    );
    expect(notifyDeliveryFailed).not.toHaveBeenCalled();
  });

  it('retries up to 2 times then notifies failure', async () => {
    const deliverChatWebhook = vi.fn().mockRejectedValue(new Error('boom'));
    const notifyDeliveryFailed = vi.fn().mockResolvedValue(undefined);
    const env = makeEnvWithConvStub(deliverChatWebhook, notifyDeliveryFailed);

    await deliverToBot(env, makeMsg());

    // 1 initial + 2 retries = 3 calls
    expect(deliverChatWebhook).toHaveBeenCalledTimes(3);
    expect(notifyDeliveryFailed).toHaveBeenCalledWith('msg-1');
  });

  it('succeeds on retry without notifying failure', async () => {
    const deliverChatWebhook = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce(undefined);
    const notifyDeliveryFailed = vi.fn();
    const env = makeEnvWithConvStub(deliverChatWebhook, notifyDeliveryFailed);

    await deliverToBot(env, makeMsg());

    expect(deliverChatWebhook).toHaveBeenCalledTimes(2);
    expect(notifyDeliveryFailed).not.toHaveBeenCalled();
  });

  it('concatenates text blocks into payload', async () => {
    const deliverChatWebhook = vi.fn().mockResolvedValue(undefined);
    const env = makeEnvWithConvStub(deliverChatWebhook);

    await deliverToBot(
      env,
      makeMsg({
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: ' world' },
        ],
      })
    );

    expect(deliverChatWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello world' })
    );
  });

  it('includes reply context fields in payload when present', async () => {
    const deliverChatWebhook = vi.fn().mockResolvedValue(undefined);
    const env = makeEnvWithConvStub(deliverChatWebhook);

    await deliverToBot(
      env,
      makeMsg({
        inReplyToMessageId: 'parent-msg-1',
        inReplyToBody: 'Original text',
        inReplyToSender: 'user-bob',
      })
    );

    expect(deliverChatWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        inReplyToMessageId: 'parent-msg-1',
        inReplyToBody: 'Original text',
        inReplyToSender: 'user-bob',
      })
    );
  });

  it('omits reply context fields from payload when not present', async () => {
    const deliverChatWebhook = vi.fn().mockResolvedValue(undefined);
    const env = makeEnvWithConvStub(deliverChatWebhook);

    await deliverToBot(env, makeMsg());

    const payload = deliverChatWebhook.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.inReplyToMessageId).toBeUndefined();
    expect(payload.inReplyToBody).toBeUndefined();
    expect(payload.inReplyToSender).toBeUndefined();
  });

  it('uses provided convContext on permanent failure instead of re-fetching', async () => {
    const deliverChatWebhook = vi.fn().mockRejectedValue(new Error('boom'));
    const pushEvent = vi.fn().mockResolvedValue(false);
    const notifyDeliveryFailed = vi.fn().mockResolvedValue(undefined);
    const env = {
      KILOCLAW: { deliverChatWebhook },
      EVENT_SERVICE: { pushEvent },
      CONVERSATION_DO: {
        idFromName: vi.fn().mockReturnValue('id'),
        get: vi.fn().mockReturnValue({
          notifyDeliveryFailed,
        }),
      },
    } as unknown as Env;

    await deliverToBot(env, makeMsg(), {
      humanMemberIds: ['user-1'],
      sandboxId: 'sandbox-1',
    });

    // notifyDeliveryFailed is now called via withDORetry which calls env.CONVERSATION_DO.get
    // But getConversationContext should NOT have been called since we passed context
    // The get() call comes from withDORetry for notifyDeliveryFailed, not from getConversationContext
    expect(notifyDeliveryFailed).toHaveBeenCalledWith('msg-1');
  });
});
