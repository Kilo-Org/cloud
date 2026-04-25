/**
 * Route handler factories for shared message/reaction/typing operations.
 *
 * Both the human-facing routes (JWT auth, /v1/ prefix) and the bot-facing
 * routes (gateway-token auth, /bot/v1/sandboxes/:sandboxId/ prefix) share
 * identical business logic. The factories here capture the boilerplate:
 * JSON parsing, Zod validation, callerId extraction, and result → HTTP mapping.
 */

import type { Context } from 'hono';
import { type ZodSchema } from 'zod';
import type { AuthContext } from '../auth';
import { withDORetry } from '@kilocode/worker-utils';
import { createBotConversationFor, renameConversationFor } from '../services/conversations';
import type { DeferCtx } from '../services/messages';
import {
  createMessageFor,
  deleteMessageFor,
  editMessageFor,
  executeActionFor,
} from '../services/messages';
import { addReactionFor, removeReactionFor } from '../services/reactions';
import { notifyMessageDeliveryFailed } from '../webhook/deliver';
import { getConversationContext, pushEventToHumanMembers } from '../services/event-push';
import { setTypingFor, stopTypingFor } from '../services/typing';
import { resolveUserDisplayInfo, type UserDisplayInfo } from '../services/user-lookup';
import type {
  CreateMessageResponse,
  EditMessageResponse,
  OkResponse,
  AddReactionResponse,
  MessageListResponse,
  BotGetMembersResponse,
  BotListConversationsResponse,
  CreateConversationResponse,
} from '@kilocode/kilo-chat';
import {
  ulidSchema,
  sandboxIdSchema,
  createMessageRequestSchema,
  createBotConversationRequestSchema,
  editMessageRequestSchema,
  executeActionRequestSchema,
  listMessagesQuerySchema,
  cursorPaginationQuerySchema,
  reactionRequestBodySchema,
  renameConversationRequestSchema,
  deleteMessageQuerySchema,
  messageDeliveryFailedRequestSchema,
  actionDeliveryFailedRequestSchema,
  decodeConversationCursor,
} from '@kilocode/kilo-chat';

type HonoCtx = Context<{ Bindings: Env; Variables: AuthContext }>;

// ─── helpers ────────────────────────────────────────────────────────────────

async function parseBody<T>(c: HonoCtx, schema: ZodSchema<T>) {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false as const, response: c.json({ error: 'Invalid JSON' }, 400) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false as const,
      response: c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400),
    };
  }
  return { ok: true as const, data: parsed.data };
}

function parseMessageId(c: HonoCtx) {
  const result = ulidSchema.safeParse(c.req.param('messageId'));
  if (!result.success) {
    return { ok: false as const, response: c.json({ error: 'Invalid message ID' }, 400) };
  }
  return { ok: true as const, data: result.data };
}

function parseConversationId(c: HonoCtx) {
  const result = ulidSchema.safeParse(c.req.param('conversationId'));
  if (!result.success) {
    return { ok: false as const, response: c.json({ error: 'Invalid conversation ID' }, 400) };
  }
  return { ok: true as const, data: result.data };
}

function parseSandboxId(c: HonoCtx) {
  const result = sandboxIdSchema.safeParse(c.req.param('sandboxId'));
  if (!result.success) {
    return { ok: false as const, response: c.json({ error: 'Invalid sandboxId' }, 400) };
  }
  return { ok: true as const, data: result.data };
}

/**
 * Verifies the authenticated caller is a member of the given conversation.
 * Used by bot-facing routes that would otherwise accept any valid gateway
 * token regardless of whether the conversation belongs to that sandbox.
 */
async function assertCallerIsMember(c: HonoCtx, conversationId: string, callerId: string) {
  const info = await withDORetry(
    () => c.env.CONVERSATION_DO.get(c.env.CONVERSATION_DO.idFromName(conversationId)),
    stub => stub.getInfo(),
    'ConversationDO.getInfo'
  );
  if (!info || !info.members.some(m => m.id === callerId)) {
    return { ok: false as const, response: c.json({ error: 'Forbidden' }, 403) };
  }
  return { ok: true as const };
}

export function makeSchedule(c: HonoCtx): DeferCtx {
  return { waitUntil: p => c.executionCtx.waitUntil(p) };
}

// ─── createMessage ──────────────────────────────────────────────────────────

export async function handleCreateMessage(c: HonoCtx) {
  const body = await parseBody(c, createMessageRequestSchema);
  if (!body.ok) return body.response;

  const callerId = c.get('callerId');
  const result = await createMessageFor(c.env, callerId, body.data, makeSchedule(c));
  if (!result.ok) {
    if (result.code === 'forbidden') return c.json({ error: result.error }, 403);
    return c.json({ error: result.error }, 500);
  }
  return c.json(
    { messageId: result.messageId, clientId: result.clientId } satisfies CreateMessageResponse,
    201
  );
}

// ─── editMessage ────────────────────────────────────────────────────────────

export async function handleEditMessage(c: HonoCtx) {
  const msgId = parseMessageId(c);
  if (!msgId.ok) return msgId.response;

  const body = await parseBody(c, editMessageRequestSchema);
  if (!body.ok) return body.response;

  const callerId = c.get('callerId');
  const result = await editMessageFor(
    c.env,
    callerId,
    {
      ...body.data,
      messageId: msgId.data,
    },
    makeSchedule(c)
  );
  if (!result.ok) {
    if (result.code === 'forbidden') return c.json({ error: result.error }, 403);
    if (result.code === 'not_found') return c.json({ error: result.error }, 404);
    return c.json({ error: result.error }, 500);
  }
  if (result.stale) {
    return c.json({ error: 'Edit conflict', messageId: result.messageId }, 409);
  }
  return c.json({ messageId: result.messageId } satisfies EditMessageResponse);
}

// ─── deleteMessage ──────────────────────────────────────────────────────────

export async function handleDeleteMessage(c: HonoCtx) {
  const msgId = parseMessageId(c);
  if (!msgId.ok) return msgId.response;

  const query = deleteMessageQuerySchema.safeParse({
    conversationId: c.req.query('conversationId'),
  });
  if (!query.success) {
    return c.json({ error: 'Invalid or missing conversationId query parameter' }, 400);
  }

  const callerId = c.get('callerId');
  const result = await deleteMessageFor(
    c.env,
    callerId,
    {
      conversationId: query.data.conversationId,
      messageId: msgId.data,
    },
    makeSchedule(c)
  );
  if (!result.ok) {
    if (result.code === 'forbidden') return c.json({ error: result.error }, 403);
    if (result.code === 'not_found') return c.json({ error: result.error }, 404);
    return c.json({ error: result.error }, 500);
  }
  return new Response(null, { status: 204 });
}

// ─── executeAction ──────────────────────────────────────────────────────────

export async function handleExecuteAction(c: HonoCtx) {
  const convId = parseConversationId(c);
  if (!convId.ok) return convId.response;

  const msgId = parseMessageId(c);
  if (!msgId.ok) return msgId.response;

  const body = await parseBody(c, executeActionRequestSchema);
  if (!body.ok) return body.response;

  const callerId = c.get('callerId');
  const result = await executeActionFor(
    c.env,
    callerId,
    {
      conversationId: convId.data,
      messageId: msgId.data,
      groupId: body.data.groupId,
      value: body.data.value,
    },
    makeSchedule(c)
  );

  if (!result.ok) {
    if (result.code === 'forbidden') return c.json({ error: result.error }, 403);
    if (result.code === 'not_found') return c.json({ error: result.error }, 404);
    if (result.code === 'already_resolved') return c.json({ error: result.error }, 409);
    if (result.code === 'invalid_value') return c.json({ error: result.error }, 400);
    return c.json({ error: result.error }, 500);
  }

  return c.json({ ok: true } satisfies OkResponse);
}

// ─── messageDeliveryFailed (bot-reported) ───────────────────────────────────

export async function handleMessageDeliveryFailed(c: HonoCtx) {
  const convId = parseConversationId(c);
  if (!convId.ok) return convId.response;
  const msgId = parseMessageId(c);
  if (!msgId.ok) return msgId.response;

  const callerId = c.get('callerId');
  const membership = await assertCallerIsMember(c, convId.data, callerId);
  if (!membership.ok) return membership.response;

  // Accept empty body. Validate when present but never fail on shape.
  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  messageDeliveryFailedRequestSchema.safeParse(body);

  await notifyMessageDeliveryFailed(c.env, {
    conversationId: convId.data,
    messageId: msgId.data,
  });
  return c.json({}, 202);
}

// ─── actionDeliveryFailed (bot-reported) ────────────────────────────────────

export async function handleActionDeliveryFailed(c: HonoCtx) {
  const convId = parseConversationId(c);
  if (!convId.ok) return convId.response;

  const groupIdRaw = c.req.param('groupId');
  if (!groupIdRaw) {
    return c.json({ error: 'Invalid groupId' }, 400);
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  const parsed = actionDeliveryFailedRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
  }

  const callerId = c.get('callerId');
  const membership = await assertCallerIsMember(c, convId.data, callerId);
  if (!membership.ok) return membership.response;

  const { messageId } = parsed.data;
  const convStub = c.env.CONVERSATION_DO.get(c.env.CONVERSATION_DO.idFromName(convId.data));
  const result = await convStub.revertActionResolution({ messageId, groupId: groupIdRaw });
  if (!result.ok) {
    return c.json({ error: result.error }, 404);
  }

  const ctx = await getConversationContext(c.env, convId.data);
  if (ctx?.sandboxId) {
    await pushEventToHumanMembers(
      c.env,
      convId.data,
      ctx.sandboxId,
      ctx.humanMemberIds,
      'action.delivery_failed',
      { conversationId: convId.data, messageId, groupId: groupIdRaw }
    );
  }
  return c.json({}, 202);
}

// ─── addReaction ─────────────────────────────────────────────────────────────

export async function handleAddReaction(c: HonoCtx) {
  const msgId = parseMessageId(c);
  if (!msgId.ok) return msgId.response;

  const body = await parseBody(c, reactionRequestBodySchema);
  if (!body.ok) return body.response;

  const callerId = c.get('callerId');
  const result = await addReactionFor(
    c.env,
    callerId,
    {
      conversationId: body.data.conversationId,
      messageId: msgId.data,
      emoji: body.data.emoji,
    },
    makeSchedule(c)
  );
  if (!result.ok) {
    if (result.code === 'forbidden') return c.json({ error: result.error }, 403);
    if (result.code === 'not_found') return c.json({ error: result.error }, 404);
    return c.json({ error: result.error }, 500);
  }
  return c.json({ id: result.id } satisfies AddReactionResponse, result.added ? 201 : 200);
}

// ─── removeReaction ──────────────────────────────────────────────────────────

export async function handleRemoveReaction(c: HonoCtx) {
  const msgId = parseMessageId(c);
  if (!msgId.ok) return msgId.response;

  const parsed = reactionRequestBodySchema.safeParse({
    conversationId: c.req.query('conversationId'),
    emoji: c.req.query('emoji'),
  });
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
  }

  const callerId = c.get('callerId');
  const result = await removeReactionFor(
    c.env,
    callerId,
    {
      conversationId: parsed.data.conversationId,
      messageId: msgId.data,
      emoji: parsed.data.emoji,
    },
    makeSchedule(c)
  );
  if (!result.ok) {
    if (result.code === 'forbidden') return c.json({ error: result.error }, 403);
    if (result.code === 'not_found') return c.json({ error: result.error }, 404);
    return c.json({ error: result.error }, 500);
  }
  return new Response(null, { status: 204 });
}

// ─── listMessages ────────────────────────────────────────────────────────────

export async function handleListMessages(c: HonoCtx) {
  const convId = parseConversationId(c);
  if (!convId.ok) return convId.response;

  const query = listMessagesQuerySchema.safeParse({
    limit: c.req.query('limit'),
    before: c.req.query('before'),
  });
  if (!query.success) {
    return c.json({ error: 'Invalid query parameters', issues: query.error.issues }, 400);
  }

  const callerId = c.get('callerId');

  // Single RPC: membership check + message fetch combined.
  const result = await withDORetry(
    () => c.env.CONVERSATION_DO.get(c.env.CONVERSATION_DO.idFromName(convId.data)),
    stub =>
      stub.listMessagesIfMember(callerId, {
        limit: query.data.limit,
        before: query.data.before,
      }),
    'ConversationDO.listMessagesIfMember'
  );

  if (result === null) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  return c.json({ messages: result.messages } satisfies MessageListResponse);
}

// ─── getMembers ──────────────────────────────────────────────────────────────

export async function handleGetMembers(c: HonoCtx) {
  const convId = parseConversationId(c);
  if (!convId.ok) return convId.response;

  const callerId = c.get('callerId');

  const info = await withDORetry(
    () => c.env.CONVERSATION_DO.get(c.env.CONVERSATION_DO.idFromName(convId.data)),
    stub => stub.getInfo(),
    'ConversationDO.getInfo'
  );
  if (!info || !info.members.some(m => m.id === callerId)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const userIds = info.members.filter(m => m.kind === 'user').map(m => m.id);
  const displayInfo =
    userIds.length > 0
      ? await resolveUserDisplayInfo(c.env.HYPERDRIVE.connectionString, userIds)
      : new Map<string, UserDisplayInfo>();

  const enrichedMembers = info.members.map(m => ({
    ...m,
    displayName: displayInfo.get(m.id)?.displayName ?? null,
    avatarUrl: displayInfo.get(m.id)?.avatarUrl ?? null,
  }));

  return c.json({ members: enrichedMembers } satisfies BotGetMembersResponse);
}

// ─── setTyping ───────────────────────────────────────────────────────────────

export async function handleSetTyping(c: HonoCtx) {
  const convId = parseConversationId(c);
  if (!convId.ok) return convId.response;

  const callerId = c.get('callerId');
  const result = await setTypingFor(c.env, callerId, { conversationId: convId.data });
  if (!result.ok) {
    return c.json({ error: result.error }, 403);
  }
  return new Response(null, { status: 204 });
}

export async function handleStopTyping(c: HonoCtx) {
  const convId = parseConversationId(c);
  if (!convId.ok) return convId.response;

  const callerId = c.get('callerId');
  const result = await stopTypingFor(c.env, callerId, { conversationId: convId.data });
  if (!result.ok) {
    return c.json({ error: result.error }, 403);
  }
  return new Response(null, { status: 204 });
}

// ─── listBotConversations ────────────────────────────────────────────────────

export async function handleListBotConversations(c: HonoCtx) {
  const sbx = parseSandboxId(c);
  if (!sbx.ok) return sbx.response;
  const sandboxId = sbx.data;

  const query = cursorPaginationQuerySchema.safeParse({
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
  });
  if (!query.success) {
    return c.json({ error: 'Invalid query parameters', issues: query.error.issues }, 400);
  }

  const botCallerId = `bot:kiloclaw:${sandboxId}`;
  const { limit, cursor: cursorRaw } = query.data;
  const cursor = cursorRaw ? decodeConversationCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) {
    return c.json({ error: 'Invalid cursor' }, 400);
  }

  const { conversations, hasMore, nextCursor } = await withDORetry(
    () => c.env.MEMBERSHIP_DO.get(c.env.MEMBERSHIP_DO.idFromName(botCallerId)),
    stub => stub.listConversations({ sandboxId, limit, cursor }),
    'MembershipDO.listConversations'
  );

  // Step 1: Fetch info for all conversations in parallel
  const conversationsWithInfo = await Promise.all(
    conversations.map(async conv => {
      const info = await withDORetry(
        () => c.env.CONVERSATION_DO.get(c.env.CONVERSATION_DO.idFromName(conv.conversationId)),
        stub => stub.getInfo(),
        'ConversationDO.getInfo'
      );
      return { conv, members: info?.members ?? [] };
    })
  );

  // Step 2: Batch-resolve all user display info
  const allUserIds = [
    ...new Set(
      conversationsWithInfo.flatMap(({ members }) =>
        members.filter(m => m.kind === 'user').map(m => m.id)
      )
    ),
  ];
  const displayInfo =
    allUserIds.length > 0
      ? await resolveUserDisplayInfo(c.env.HYPERDRIVE.connectionString, allUserIds)
      : new Map<string, UserDisplayInfo>();

  // Step 3: Build enriched response
  const enriched = conversationsWithInfo.map(({ conv, members }) => ({
    conversationId: conv.conversationId,
    title: conv.title,
    lastActivityAt: conv.lastActivityAt,
    members: members.map(m => ({
      ...m,
      displayName: displayInfo.get(m.id)?.displayName ?? null,
      avatarUrl: displayInfo.get(m.id)?.avatarUrl ?? null,
    })),
  }));

  return c.json({
    conversations: enriched,
    hasMore,
    nextCursor,
  } satisfies BotListConversationsResponse);
}

// ─── createBotConversation ──────────────────────────────────────────────────

export async function handleCreateBotConversation(c: HonoCtx) {
  const sbx = parseSandboxId(c);
  if (!sbx.ok) return sbx.response;
  const sandboxId = sbx.data;

  const body = await parseBody(c, createBotConversationRequestSchema);
  if (!body.ok) return body.response;

  const result = await createBotConversationFor(c.env, {
    sandboxId,
    title: body.data.title,
    additionalMembers: body.data.additionalMembers,
  });

  if (!result.ok) {
    if (result.code === 'not_found') return c.json({ error: result.error }, 404);
    if (result.code === 'invalid_members') {
      return c.json({ error: result.error, invalidMembers: result.invalidMembers }, 400);
    }
    return c.json({ error: result.error }, 500);
  }

  return c.json(
    { conversationId: result.conversationId } satisfies CreateConversationResponse,
    201
  );
}

// ─── renameConversation ─────────────────────────────────────────────────────

export async function handleRenameConversation(c: HonoCtx) {
  const convId = parseConversationId(c);
  if (!convId.ok) return convId.response;

  const body = await parseBody(c, renameConversationRequestSchema);
  if (!body.ok) return body.response;

  const callerId = c.get('callerId');
  const result = await renameConversationFor(
    c.env,
    callerId,
    {
      conversationId: convId.data,
      title: body.data.title,
    },
    makeSchedule(c)
  );
  if (!result.ok) {
    return c.json({ error: result.error }, 403);
  }

  return c.json({ ok: true } satisfies OkResponse);
}
