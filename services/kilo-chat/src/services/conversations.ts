/**
 * Identity-agnostic conversation operations.
 * See services/messages.ts for the rationale behind this pattern.
 */

import { ulid } from 'ulid';

// ─── createConversation ────────────────────────────────────────────────────

export type CreateConversationParams = {
  sandboxId: string;
  title?: string;
};

export type CreateConversationResult =
  | { ok: true; conversationId: string }
  | { ok: false; code: 'forbidden' | 'internal'; error: string };

export async function createConversationFor(
  env: Env,
  userId: string,
  params: CreateConversationParams,
  allowedSandboxIds?: string[]
): Promise<CreateConversationResult> {
  // HTTP path supplies allowedSandboxIds from JWT; RPC path omits it (trusted).
  if (allowedSandboxIds && !allowedSandboxIds.includes(params.sandboxId)) {
    return { ok: false, code: 'forbidden', error: 'You do not have access to this sandbox' };
  }

  const conversationId = ulid();
  const now = Date.now();
  const botId = `bot:kiloclaw:${params.sandboxId}`;

  const convStub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(conversationId));
  const initResult = await convStub.initialize({
    id: conversationId,
    title: params.title ?? null,
    createdBy: userId,
    createdAt: now,
    members: [
      { id: userId, kind: 'user' },
      { id: botId, kind: 'bot' },
    ],
  });

  if (!initResult.ok) {
    return { ok: false, code: 'internal', error: 'Failed to initialize conversation' };
  }

  const memberParams = {
    conversationId,
    conversationTitle: params.title ?? null,
    sandboxId: params.sandboxId,
    joinedAt: now,
  };

  const userMembership = env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(userId));
  const botMembership = env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(botId));
  await Promise.all([
    userMembership.addConversation(memberParams),
    botMembership.addConversation(memberParams),
  ]);

  return { ok: true, conversationId };
}

// ─── renameConversation ────────────────────────────────────────────────────

export type RenameConversationParams = {
  conversationId: string;
  title: string;
};

export type RenameConversationResult =
  | { ok: true }
  | { ok: false; code: 'forbidden'; error: string };

export async function renameConversationFor(
  env: Env,
  userId: string,
  params: RenameConversationParams
): Promise<RenameConversationResult> {
  const { conversationId, title } = params;
  const convStub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(conversationId));

  if (!(await convStub.isMember(userId))) {
    return { ok: false, code: 'forbidden', error: 'Forbidden' };
  }

  await convStub.updateTitle(title);

  const info = await convStub.getInfo();
  if (info) {
    await Promise.all(
      info.members.map(member => {
        const memberStub = env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(member.id));
        return memberStub.updateConversationTitle(conversationId, title);
      })
    );
  }

  return { ok: true };
}

// ─── leaveConversation ─────────────────────────────────────────────────────

export type LeaveConversationParams = {
  conversationId: string;
};

export type LeaveConversationResult =
  | { ok: true }
  | { ok: false; code: 'forbidden'; error: string };

export async function leaveConversationFor(
  env: Env,
  userId: string,
  params: LeaveConversationParams
): Promise<LeaveConversationResult> {
  const { conversationId } = params;
  const convStub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(conversationId));

  if (!(await convStub.isMember(userId))) {
    return { ok: false, code: 'forbidden', error: 'Forbidden' };
  }

  const { remainingUsers, botMembers } = await convStub.leaveMember(userId);

  const callerMembership = env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(userId));
  await callerMembership.removeConversation(conversationId);

  if (remainingUsers.length === 0) {
    await Promise.all(
      botMembers.map(member => {
        const memberStub = env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(member.id));
        return memberStub.removeConversation(conversationId);
      })
    );
  }

  return { ok: true };
}

// ─── markRead ──────────────────────────────────────────────────────────────

export type MarkReadParams = {
  conversationId: string;
};

export type MarkReadResult =
  | { ok: true }
  | { ok: false; code: 'forbidden'; error: string };

export async function markReadFor(
  env: Env,
  userId: string,
  params: MarkReadParams
): Promise<MarkReadResult> {
  const { conversationId } = params;
  const convStub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(conversationId));

  if (!(await convStub.isMember(userId))) {
    return { ok: false, code: 'forbidden', error: 'Forbidden' };
  }

  const stub = env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(userId));
  await stub.markRead(conversationId, Date.now());

  return { ok: true };
}
