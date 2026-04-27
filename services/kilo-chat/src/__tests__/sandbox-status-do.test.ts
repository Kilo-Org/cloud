import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { SandboxStatusDO } from '../do/sandbox-status-do';

function getStub(sandboxId: string): DurableObjectStub<SandboxStatusDO> {
  const id = env.SANDBOX_STATUS_DO.idFromName(sandboxId);
  return env.SANDBOX_STATUS_DO.get(id);
}

describe('SandboxStatusDO', () => {
  it('getBotStatus returns null before any write', async () => {
    const stub = getStub('sandbox-empty-bot');
    const result = await stub.getBotStatus();
    expect(result).toBeNull();
  });

  it('getConversationStatus returns null for any cid before any write', async () => {
    const stub = getStub('sandbox-empty-cv');
    const result = await stub.getConversationStatus('conv-x');
    expect(result).toBeNull();
  });

  it('putBotStatus then getBotStatus round-trips', async () => {
    const stub = getStub('sandbox-bot-1');
    await stub.putBotStatus({ online: true, at: 1000 });
    const result = await stub.getBotStatus();
    expect(result?.online).toBe(true);
    expect(result?.at).toBe(1000);
    expect(typeof result?.updatedAt).toBe('number');
  });

  it('successive putBotStatus calls overwrite (last write wins)', async () => {
    const stub = getStub('sandbox-bot-2');
    await stub.putBotStatus({ online: true, at: 1000 });
    await stub.putBotStatus({ online: false, at: 2000 });
    const result = await stub.getBotStatus();
    expect(result?.online).toBe(false);
    expect(result?.at).toBe(2000);
  });

  it('putConversationStatus stores per-conversation rows', async () => {
    const stub = getStub('sandbox-cv-1');
    await stub.putConversationStatus({
      conversationId: 'conv-A',
      contextTokens: 100,
      contextWindow: 1000,
      model: 'gpt-4',
      provider: 'openai',
      at: 1234,
    });
    const a = await stub.getConversationStatus('conv-A');
    expect(a).toMatchObject({
      conversationId: 'conv-A',
      contextTokens: 100,
      contextWindow: 1000,
      model: 'gpt-4',
      provider: 'openai',
      at: 1234,
    });

    const b = await stub.getConversationStatus('conv-B');
    expect(b).toBeNull();
  });

  it('successive putConversationStatus for same cid overwrites', async () => {
    const stub = getStub('sandbox-cv-2');
    await stub.putConversationStatus({
      conversationId: 'conv-A',
      contextTokens: 100,
      contextWindow: 1000,
      model: null,
      provider: null,
      at: 1000,
    });
    await stub.putConversationStatus({
      conversationId: 'conv-A',
      contextTokens: 250,
      contextWindow: 1000,
      model: 'sonnet',
      provider: 'anthropic',
      at: 2000,
    });
    const result = await stub.getConversationStatus('conv-A');
    expect(result?.contextTokens).toBe(250);
    expect(result?.model).toBe('sonnet');
  });

  it('putBotStatus does not affect any conversation row', async () => {
    const stub = getStub('sandbox-iso-1');
    await stub.putConversationStatus({
      conversationId: 'conv-A',
      contextTokens: 100,
      contextWindow: 1000,
      model: 'm',
      provider: 'p',
      at: 1000,
    });
    await stub.putBotStatus({ online: true, at: 5000 });
    const cv = await stub.getConversationStatus('conv-A');
    expect(cv?.contextTokens).toBe(100);
    expect(cv?.model).toBe('m');
  });

  it('putConversationStatus does not affect the bot row', async () => {
    const stub = getStub('sandbox-iso-2');
    await stub.putBotStatus({ online: true, at: 1000 });
    await stub.putConversationStatus({
      conversationId: 'conv-A',
      contextTokens: 100,
      contextWindow: 1000,
      model: 'm',
      provider: 'p',
      at: 5000,
    });
    const bot = await stub.getBotStatus();
    expect(bot?.at).toBe(1000);
    expect(bot?.online).toBe(true);
  });

  it('putBotStatus ignores regressed at (monotonic)', async () => {
    const stub = getStub('sandbox-bot-monotonic');
    await stub.putBotStatus({ online: true, at: 2000 });
    await stub.putBotStatus({ online: false, at: 1000 });
    const result = await stub.getBotStatus();
    expect(result?.online).toBe(true);
    expect(result?.at).toBe(2000);
  });

  it('putConversationStatus ignores regressed at (monotonic)', async () => {
    const stub = getStub('sandbox-cv-monotonic');
    await stub.putConversationStatus({
      conversationId: 'conv-A',
      contextTokens: 250,
      contextWindow: 1000,
      model: 'sonnet',
      provider: 'anthropic',
      at: 2000,
    });
    await stub.putConversationStatus({
      conversationId: 'conv-A',
      contextTokens: 100,
      contextWindow: 1000,
      model: 'haiku',
      provider: 'anthropic',
      at: 1000,
    });
    const result = await stub.getConversationStatus('conv-A');
    expect(result?.at).toBe(2000);
    expect(result?.contextTokens).toBe(250);
    expect(result?.model).toBe('sonnet');
  });

  it('destroy clears both tables', async () => {
    const stub = getStub('sandbox-destroy');
    await stub.putBotStatus({ online: true, at: 1000 });
    await stub.putConversationStatus({
      conversationId: 'conv-A',
      contextTokens: 1,
      contextWindow: 100,
      model: null,
      provider: null,
      at: 1000,
    });
    await stub.destroy();

    expect(await stub.getBotStatus()).toBeNull();
    expect(await stub.getConversationStatus('conv-A')).toBeNull();
  });
});
