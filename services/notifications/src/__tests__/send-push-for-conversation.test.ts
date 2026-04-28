import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendPushForConversationCore } from '../index';
import type { SendPushDeps } from '../index';
import type { SendPushForConversationInput } from '@kilocode/notifications';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDeps(
  outcome: { kind: string; tokenCount?: number } = { kind: 'delivered', tokenCount: 1 }
): SendPushDeps {
  const dispatchPush = vi.fn().mockResolvedValue(outcome);
  return {
    getConversationDOStub: vi.fn().mockReturnValue({ dispatchPush }),
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const baseInput: SendPushForConversationInput = {
  conversationId: 'c1',
  sandboxId: 's1',
  senderUserId: 'sender',
  recipientUserIds: ['sender', 'r1', 'r2', 'r2'], // sender + dup
  title: 'T',
  bodyPreview: 'B',
  messageId: 'm1',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('sendPushForConversationCore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('excludes sender and deduplicates recipients', async () => {
    const deps = makeDeps();
    const out = await sendPushForConversationCore(baseInput, deps);

    // sender excluded, r2 deduped → only r1 and r2 (once each)
    const dispatchPush = (deps.getConversationDOStub as ReturnType<typeof vi.fn>)().dispatchPush;
    expect(dispatchPush).toHaveBeenCalledTimes(2);
    expect(out.perRecipient).toHaveLength(2);
  });

  it('returns correct userId in perRecipient entries', async () => {
    const deps = makeDeps();
    const out = await sendPushForConversationCore(
      {
        ...baseInput,
        senderUserId: null,
        recipientUserIds: ['r1', 'r2'],
      },
      deps
    );

    expect(out.perRecipient.map(r => r.userId)).toEqual(['r1', 'r2']);
  });

  it('passes expected args to dispatchPush including presence context and idempotency key', async () => {
    const deps = makeDeps();
    await sendPushForConversationCore({ ...baseInput, recipientUserIds: ['r1'] }, deps);

    const dispatchPush = (deps.getConversationDOStub as ReturnType<typeof vi.fn>)().dispatchPush;
    expect(dispatchPush).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'r1',
        presenceContext: '/presence/kiloclaw/chat/c1',
        idempotencyKey: 'chat:m1:r1',
        badge: { badgeBucket: 'c1', delta: 1 },
      })
    );
  });

  it('maps outcome.kind to perRecipient outcome', async () => {
    const deps = makeDeps({ kind: 'suppressed_presence' });
    const out = await sendPushForConversationCore({ ...baseInput, recipientUserIds: ['r1'] }, deps);

    expect(out.perRecipient[0]).toEqual({ userId: 'r1', outcome: 'suppressed_presence' });
  });

  it('returns empty perRecipient when all recipients are the sender', async () => {
    const deps = makeDeps();
    const out = await sendPushForConversationCore(
      { ...baseInput, recipientUserIds: ['sender'] },
      deps
    );

    const dispatchPush = (deps.getConversationDOStub as ReturnType<typeof vi.fn>)().dispatchPush;
    expect(dispatchPush).not.toHaveBeenCalled();
    expect(out.perRecipient).toHaveLength(0);
  });

  it('looks up DO stub by conversationId for each recipient', async () => {
    const deps = makeDeps();
    await sendPushForConversationCore({ ...baseInput, recipientUserIds: ['r1', 'r2'] }, deps);

    expect(deps.getConversationDOStub).toHaveBeenCalledTimes(2);
    expect(deps.getConversationDOStub).toHaveBeenCalledWith('c1');
  });
});
