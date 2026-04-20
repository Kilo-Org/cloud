import { describe, it, expect, vi } from 'vitest';
import { deliverToBot } from '../webhook/deliver';

function makeMsg(overrides?: Partial<Parameters<typeof deliverToBot>[2]>) {
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

describe('deliverToBot', () => {
  it('delivers via KILOCLAW RPC on first attempt', async () => {
    const deliverChatWebhook = vi.fn().mockResolvedValue(undefined);
    const env = { KILOCLAW: { deliverChatWebhook } } as unknown as Env;
    const convStub = { notifyDeliveryFailed: vi.fn() };

    await deliverToBot(env, convStub, makeMsg());

    expect(deliverChatWebhook).toHaveBeenCalledOnce();
    expect(deliverChatWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        targetBotId: 'bot:kiloclaw:sandbox-1',
        conversationId: 'conv-1',
        text: 'Hello',
      })
    );
    expect(convStub.notifyDeliveryFailed).not.toHaveBeenCalled();
  });

  it('retries up to 2 times then notifies failure', async () => {
    const deliverChatWebhook = vi.fn().mockRejectedValue(new Error('boom'));
    const env = { KILOCLAW: { deliverChatWebhook } } as unknown as Env;
    const convStub = { notifyDeliveryFailed: vi.fn().mockResolvedValue(undefined) };

    await deliverToBot(env, convStub, makeMsg());

    // 1 initial + 2 retries = 3 calls
    expect(deliverChatWebhook).toHaveBeenCalledTimes(3);
    expect(convStub.notifyDeliveryFailed).toHaveBeenCalledWith('msg-1', 'user-1');
  });

  it('succeeds on retry without notifying failure', async () => {
    const deliverChatWebhook = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce(undefined);
    const env = { KILOCLAW: { deliverChatWebhook } } as unknown as Env;
    const convStub = { notifyDeliveryFailed: vi.fn() };

    await deliverToBot(env, convStub, makeMsg());

    expect(deliverChatWebhook).toHaveBeenCalledTimes(2);
    expect(convStub.notifyDeliveryFailed).not.toHaveBeenCalled();
  });

  it('concatenates text blocks into payload', async () => {
    const deliverChatWebhook = vi.fn().mockResolvedValue(undefined);
    const env = { KILOCLAW: { deliverChatWebhook } } as unknown as Env;
    const convStub = { notifyDeliveryFailed: vi.fn() };

    await deliverToBot(
      env,
      convStub,
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
});
