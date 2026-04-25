/**
 * Identity-agnostic conversation operations.
 * See services/messages.ts for the rationale behind this pattern.
 */

import { ulid } from 'ulid';
import { withDORetry } from '@kilocode/worker-utils';
import { extractConversationContext, extractSandboxId, pushInstanceEvent } from './event-push';
import { lookupSandboxOwnerUserId, userOwnsSandbox } from './sandbox-ownership';
import { validateUserIds } from './user-lookup';
import type { DeferCtx } from './messages';
import type { ConversationDO, UpdateTitleIfMemberResult } from '../do/conversation-do';

// ─── partial-failure rollback helpers ──────────────────────────────────────

type MemberAddParams = {
  conversationId: string;
  title: string | null;
  sandboxId: string;
  joinedAt: number;
};

/**
 * Fan out `addConversation` to each member's MembershipDO. Accumulates the
 * member IDs whose writes succeeded into `succeededMemberIds` as they resolve
 * so the caller can roll back only those on failure. Throws the first
 * rejection after all writes settle.
 */
async function fanOutAddConversation(
  env: Env,
  memberIds: string[],
  params: MemberAddParams,
  succeededMemberIds: string[]
): Promise<void> {
  const settled = await Promise.allSettled(
    memberIds.map(async id => {
      const stub = env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(id));
      await stub.addConversation(params);
      succeededMemberIds.push(id);
    })
  );
  for (const r of settled) {
    if (r.status === 'rejected') throw r.reason;
  }
}

/**
 * Called when a conversation-creation path fails AFTER ConversationDO.initialize()
 * has succeeded. Destroys the conversation state and removes any membership
 * rows that were written before the failure. All rollback steps are
 * best-effort so the original error is the one that propagates.
 */
async function rollbackConversationCreation(
  env: Env,
  convStub: DurableObjectStub<ConversationDO>,
  conversationId: string,
  succeededMemberIds: string[]
): Promise<void> {
  const membershipRemovals = succeededMemberIds.map(id => {
    const stub = env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(id));
    return stub.removeConversation(conversationId);
  });
  await Promise.allSettled([convStub.destroyAndReturnMembers(), ...membershipRemovals]);
}

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
  const owns = await userOwnsSandbox(env, userId, params.sandboxId);
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
    title: params.title ?? null,
    sandboxId: params.sandboxId,
    joinedAt: now,
  };

  const succeededMemberIds: string[] = [];
  try {
    await fanOutAddConversation(env, [userId, botId], memberParams, succeededMemberIds);
  } catch (err) {
    await rollbackConversationCreation(env, convStub, conversationId, succeededMemberIds);
    throw err;
  }

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
  const ownerId = await lookupSandboxOwnerUserId(env, params.sandboxId);
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
    title: params.title ?? null,
    sandboxId: params.sandboxId,
    joinedAt: now,
  };

  const memberIds = members.map(m => m.id);
  const succeededMemberIds: string[] = [];
  try {
    await fanOutAddConversation(env, memberIds, memberParams, succeededMemberIds);
  } catch (err) {
    await rollbackConversationCreation(env, convStub, conversationId, succeededMemberIds);
    throw err;
  }

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
  params: RenameConversationParams,
  ctx: DeferCtx
): Promise<RenameConversationResult> {
  const { conversationId, title } = params;

  const result = await withDORetry(
    () => env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(conversationId)),
    (stub): Promise<UpdateTitleIfMemberResult> => stub.updateTitleIfMember(userId, title),
    'ConversationDO.updateTitleIfMember'
  );
  if (!result.ok) {
    return { ok: false, code: 'forbidden', error: 'Forbidden' };
  }

  const fanOut = async () => {
    await Promise.all(
      result.members.map(member =>
        withDORetry(
          () => env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(member.id)),
          stub => stub.updateConversationTitle(conversationId, title),
          'MembershipDO.updateConversationTitle'
        )
      )
    );
    const { humanMemberIds, sandboxId } = extractConversationContext(result.members);
    if (sandboxId) {
      await pushInstanceEvent(env, sandboxId, humanMemberIds, 'conversation.renamed', {
        conversationId,
        title,
      });
    }
  };

  ctx.waitUntil(fanOut());

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
  params: LeaveConversationParams,
  ctx: DeferCtx
): Promise<LeaveConversationResult> {
  const { conversationId } = params;

  const convStub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(conversationId));
  const result = await convStub.leaveMemberIfMember(userId);
  if (!result.ok) {
    return { ok: false, code: 'forbidden', error: 'Forbidden' };
  }

  const fanOut = async () => {
    const callerMembership = env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(userId));
    await callerMembership.removeConversation(conversationId);

    if (result.remainingUsers.length === 0) {
      await Promise.all(
        result.botMembers.map(member => {
          const memberStub = env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(member.id));
          return memberStub.removeConversation(conversationId);
        })
      );
    }

    const botMember = result.botMembers[0];
    const sandboxId = botMember ? extractSandboxId(botMember.id) : null;
    if (sandboxId) {
      await pushInstanceEvent(env, sandboxId, [userId], 'conversation.left', {
        conversationId,
      });
    }
  };

  ctx.waitUntil(fanOut());

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
  params: MarkReadParams,
  ctx: DeferCtx
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
    const pushPromise = pushInstanceEvent(env, sandboxId, humanMemberIds, 'conversation.read', {
      conversationId,
      memberId: userId,
      lastReadAt: now,
    });
    ctx.waitUntil(pushPromise);
  }

  return { ok: true };
}
