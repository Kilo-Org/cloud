/**
 * Identity-agnostic conversation operations.
 * See services/messages.ts for the rationale behind this pattern.
 */

import { ulid } from 'ulid';
import { withDORetry } from '@kilocode/worker-utils';
import { extractConversationContext, extractSandboxId, pushInstanceEvent } from './event-push';
import { getSandboxOwner, userOwnsSandbox } from './sandbox-ownership';
import { validateUserIds } from './user-lookup';

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
  params: CreateConversationParams
): Promise<CreateConversationResult> {
  const owns = await userOwnsSandbox(env.HYPERDRIVE.connectionString, userId, params.sandboxId);
  if (!owns) {
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

  // Notify all human members on the instance context so their conversation list updates.
  await pushInstanceEvent(env, params.sandboxId, [userId], 'conversation.created', {
    conversationId,
  });

  return { ok: true, conversationId };
}

// ─── createBotConversation ─────────────────────────────────────────────────

export type CreateBotConversationParams = {
  sandboxId: string;
  title?: string;
  additionalMembers?: string[];
};

export type CreateBotConversationResult =
  | { ok: true; conversationId: string }
  | {
      ok: false;
      code: 'not_found' | 'invalid_members' | 'internal';
      error: string;
      invalidMembers?: string[];
    };

export async function createBotConversationFor(
  env: Env,
  params: CreateBotConversationParams
): Promise<CreateBotConversationResult> {
  const ownerId = await getSandboxOwner(env.HYPERDRIVE.connectionString, params.sandboxId);
  if (!ownerId) {
    return { ok: false, code: 'not_found', error: 'Sandbox owner not found' };
  }

  const additionalMembers = params.additionalMembers ?? [];
  if (additionalMembers.length > 0) {
    const { invalid } = await validateUserIds(env.HYPERDRIVE.connectionString, additionalMembers);
    if (invalid.length > 0) {
      return {
        ok: false,
        code: 'invalid_members',
        error: `Invalid member IDs: ${invalid.join(', ')}`,
        invalidMembers: invalid,
      };
    }
  }

  const conversationId = ulid();
  const now = Date.now();
  const botId = `bot:kiloclaw:${params.sandboxId}`;

  const members: Array<{ id: string; kind: 'user' | 'bot' }> = [
    { id: ownerId, kind: 'user' },
    { id: botId, kind: 'bot' },
    ...additionalMembers
      .filter(id => id !== ownerId) // Dedupe owner if passed in additionalMembers
      .map(id => ({ id, kind: 'user' as const })),
  ];

  const convStub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(conversationId));
  const initResult = await convStub.initialize({
    id: conversationId,
    title: params.title ?? null,
    createdBy: botId,
    createdAt: now,
    members,
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

  await Promise.all(
    members.map(m => {
      const stub = env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(m.id));
      return stub.addConversation(memberParams);
    })
  );

  const humanMemberIds = members.filter(m => m.kind === 'user').map(m => m.id);
  await pushInstanceEvent(env, params.sandboxId, humanMemberIds, 'conversation.created', {
    conversationId,
  });

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

  // Single getInfo() call: membership check + member list for fan-out.
  const info = await withDORetry(
    () => env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(conversationId)),
    stub => stub.getInfo(),
    'ConversationDO.getInfo'
  );
  if (!info || !info.members.some(m => m.id === userId)) {
    return { ok: false, code: 'forbidden', error: 'Forbidden' };
  }

  await withDORetry(
    () => env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(conversationId)),
    stub => stub.updateTitle(title),
    'ConversationDO.updateTitle'
  );

  await Promise.all(
    info.members.map(member =>
      withDORetry(
        () => env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(member.id)),
        stub => stub.updateConversationTitle(conversationId, title),
        'MembershipDO.updateConversationTitle'
      )
    )
  );
  const { humanMemberIds, sandboxId } = extractConversationContext(info.members);
  if (sandboxId) {
    await pushInstanceEvent(env, sandboxId, humanMemberIds, 'conversation.renamed', {
      conversationId,
      title,
    });
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

  const isMember = await withDORetry(
    () => env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(conversationId)),
    stub => stub.isMember(userId),
    'ConversationDO.isMember'
  );
  if (!isMember) {
    return { ok: false, code: 'forbidden', error: 'Forbidden' };
  }

  const convStub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(conversationId));

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

  // Notify the user's other clients so their conversation list updates.
  const botMember = botMembers[0];
  const sandboxId = botMember ? extractSandboxId(botMember.id) : null;
  if (sandboxId) {
    await pushInstanceEvent(env, sandboxId, [userId], 'conversation.left', {
      conversationId,
    });
  }

  return { ok: true };
}

// ─── markRead ──────────────────────────────────────────────────────────────

export type MarkReadParams = {
  conversationId: string;
};

export type MarkReadResult = { ok: true } | { ok: false; code: 'forbidden'; error: string };

export async function markReadFor(
  env: Env,
  userId: string,
  params: MarkReadParams
): Promise<MarkReadResult> {
  const { conversationId } = params;

  // Single getInfo() call for both membership check and context extraction.
  const info = await withDORetry(
    () => env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(conversationId)),
    stub => stub.getInfo(),
    'ConversationDO.getInfo'
  );
  if (!info || !info.members.some(m => m.id === userId)) {
    return { ok: false, code: 'forbidden', error: 'Forbidden' };
  }

  const now = Date.now();
  await withDORetry(
    () => env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(userId)),
    stub => stub.markRead(conversationId, now),
    'MembershipDO.markRead'
  );

  const { humanMemberIds, sandboxId } = extractConversationContext(info.members);
  if (sandboxId) {
    await pushInstanceEvent(env, sandboxId, humanMemberIds, 'conversation.read', {
      conversationId,
      memberId: userId,
      lastReadAt: now,
    });
  }

  return { ok: true };
}
