import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { ConversationDO } from '../do/conversation-do';
import type { MembershipDO } from '../do/membership-do';

function getConvStub(convId: string): DurableObjectStub<ConversationDO> {
  return env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(convId));
}

function getMemberStub(memberId: string): DurableObjectStub<MembershipDO> {
  return env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(memberId));
}

const SANDBOX_ID = 'sandbox-to-destroy';
const BOT_ID = `bot:kiloclaw:${SANDBOX_ID}`;
const USER_ID = 'user-alice';
const OTHER_SANDBOX = 'sandbox-keep';

async function seedConversation(
  convId: string,
  sandboxId: string,
  userIds: string[],
  botId: string
) {
  const convStub = getConvStub(convId);
  const members = [
    ...userIds.map(id => ({ id, kind: 'user' as const })),
    { id: botId, kind: 'bot' as const },
  ];
  await convStub.initialize({
    id: convId,
    title: `Chat ${convId}`,
    createdBy: userIds[0],
    createdAt: Date.now(),
    members,
  });
  await convStub.createMessage({
    senderId: userIds[0],
    content: [{ type: 'text', text: 'hello' }],
  });

  const memberParams = {
    conversationId: convId,
    title: `Chat ${convId}`,
    sandboxId,
    joinedAt: Date.now(),
  };
  for (const m of members) {
    const stub = getMemberStub(m.id);
    await stub.addConversation(memberParams);
  }
}

describe('destroySandboxData', () => {
  it('deletes all conversations, messages, and membership entries for a sandbox', async () => {
    // Seed two conversations for the doomed sandbox
    await seedConversation('conv-doomed-1', SANDBOX_ID, [USER_ID], BOT_ID);
    await seedConversation('conv-doomed-2', SANDBOX_ID, [USER_ID], BOT_ID);
    // Seed one conversation for a different sandbox (should survive)
    const otherBot = `bot:kiloclaw:${OTHER_SANDBOX}`;
    await seedConversation('conv-keep', OTHER_SANDBOX, [USER_ID], otherBot);

    // Seed bot + conversation status for doomed sandbox.
    const statusStub = env.SANDBOX_STATUS_DO.get(env.SANDBOX_STATUS_DO.idFromName(SANDBOX_ID));
    await statusStub.putBotStatus({ online: true, at: 1700000000000 });
    await statusStub.putConversationStatus({
      conversationId: 'conv-doomed-1',
      contextTokens: 100,
      contextWindow: 1000,
      model: 'm',
      provider: 'p',
      at: 1700000000000,
    });

    // Call the RPC method via the self-referencing service binding.
    // KILO_CHAT_SELF is only in miniflare config, not in the Env type, so cast.
    const worker = (env as unknown as Record<string, unknown>).KILO_CHAT_SELF as {
      destroySandboxData(
        sandboxId: string
      ): Promise<{ ok: boolean; conversationsDeleted: number; failedConversations: string[] }>;
    };
    const result = await worker.destroySandboxData(SANDBOX_ID);
    expect(result.ok).toBe(true);
    expect(result.conversationsDeleted).toBe(2);
    expect(result.failedConversations).toEqual([]);

    // Verify doomed conversations are wiped
    const conv1 = await getConvStub('conv-doomed-1').getInfo();
    expect(conv1).toBeNull();
    const conv2 = await getConvStub('conv-doomed-2').getInfo();
    expect(conv2).toBeNull();

    // Verify user's membership for doomed sandbox is gone, but other sandbox survives
    const userMembership = await getMemberStub(USER_ID).listConversations();
    expect(userMembership.conversations).toHaveLength(1);
    expect(userMembership.conversations[0].conversationId).toBe('conv-keep');

    // Verify bot's membership is empty
    const botMembership = await getMemberStub(BOT_ID).listConversations();
    expect(botMembership.hasMore).toBe(false);

    // Verify surviving conversation is intact
    const kept = await getConvStub('conv-keep').getInfo();
    expect(kept).not.toBeNull();
    expect(kept!.id).toBe('conv-keep');

    // Verify sandbox status rows are wiped.
    expect(await statusStub.getBotStatus()).toBeNull();
    expect(await statusStub.getConversationStatus('conv-doomed-1')).toBeNull();
  });

  it('returns zero when sandbox has no conversations', async () => {
    const worker = (env as unknown as Record<string, unknown>).KILO_CHAT_SELF as {
      destroySandboxData(
        sandboxId: string
      ): Promise<{ ok: boolean; conversationsDeleted: number; failedConversations: string[] }>;
    };
    const result = await worker.destroySandboxData('sandbox-nonexistent');
    expect(result.ok).toBe(true);
    expect(result.conversationsDeleted).toBe(0);
    expect(result.failedConversations).toEqual([]);
  });
});
