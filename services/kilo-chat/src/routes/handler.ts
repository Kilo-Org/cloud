/**
 * Route handler factories for shared message/reaction/typing operations.
 *
 * Both the human-facing routes (JWT auth, /v1/ prefix) and the bot-facing
 * routes (gateway-token auth, /bot/v1/sandboxes/:sandboxId/ prefix) share
 * identical business logic. The factories here capture the boilerplate:
 * JSON parsing, Zod validation, callerId extraction, and result → HTTP mapping.
 */

import type { Context } from 'hono';
import type { ZodSchema } from 'zod';
import type { AuthContext } from '../auth';
import { renameConversationFor } from '../services/conversations';
import { createMessageFor, deleteMessageFor, editMessageFor } from '../services/messages';
import { addReactionFor, removeReactionFor } from '../services/reactions';
import { setTypingFor, stopTypingFor } from '../services/typing';
import {
  ulidSchema,
  createMessageSchema,
  editMessageSchema,
  reactionBodySchema,
  renameConversationSchema,
} from './schemas';

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

function makeSchedule(c: HonoCtx) {
  return (p: Promise<unknown>) => {
    try {
      c.executionCtx.waitUntil(p);
    } catch {
      // executionCtx unavailable (e.g. unit tests); drop the waitUntil.
    }
  };
}

// ─── createMessage ──────────────────────────────────────────────────────────

export async function handleCreateMessage(c: HonoCtx) {
  const body = await parseBody(c, createMessageSchema);
  if (!body.ok) return body.response;

  const callerId = c.get('callerId');
  const result = await createMessageFor(c.env, callerId, body.data, {
    waitUntil: makeSchedule(c),
  });
  if (!result.ok) {
    if (result.code === 'forbidden') return c.json({ error: result.error }, 403);
    return c.json({ error: result.error }, 500);
  }
  return c.json(
    { messageId: result.messageId, ...(result.clientId ? { clientId: result.clientId } : {}) },
    201
  );
}

// ─── editMessage ────────────────────────────────────────────────────────────

export async function handleEditMessage(c: HonoCtx) {
  const msgId = parseMessageId(c);
  if (!msgId.ok) return msgId.response;

  const body = await parseBody(c, editMessageSchema);
  if (!body.ok) return body.response;

  const callerId = c.get('callerId');
  const result = await editMessageFor(c.env, callerId, {
    ...body.data,
    messageId: msgId.data,
  });
  if (!result.ok) {
    if (result.code === 'forbidden') return c.json({ error: result.error }, 403);
    if (result.code === 'not_found') return c.json({ error: result.error }, 404);
    return c.json({ error: result.error }, 500);
  }
  if (result.stale) {
    return c.json({ error: 'Edit conflict', messageId: result.messageId }, 409);
  }
  return c.json({ messageId: result.messageId });
}

// ─── deleteMessage ──────────────────────────────────────────────────────────

export async function handleDeleteMessage(c: HonoCtx) {
  const msgId = parseMessageId(c);
  if (!msgId.ok) return msgId.response;

  const convId = ulidSchema.safeParse(c.req.query('conversationId'));
  if (!convId.success) {
    return c.json({ error: 'Invalid or missing conversationId query parameter' }, 400);
  }

  const callerId = c.get('callerId');
  const result = await deleteMessageFor(c.env, callerId, {
    conversationId: convId.data,
    messageId: msgId.data,
  });
  if (!result.ok) {
    if (result.code === 'forbidden') return c.json({ error: result.error }, 403);
    if (result.code === 'not_found') return c.json({ error: result.error }, 404);
    return c.json({ error: result.error }, 500);
  }
  return new Response(null, { status: 204 });
}

// ─── addReaction ─────────────────────────────────────────────────────────────

export async function handleAddReaction(c: HonoCtx) {
  const msgId = parseMessageId(c);
  if (!msgId.ok) return msgId.response;

  const body = await parseBody(c, reactionBodySchema);
  if (!body.ok) return body.response;

  const callerId = c.get('callerId');
  const result = await addReactionFor(c.env, callerId, {
    conversationId: body.data.conversationId,
    messageId: msgId.data,
    emoji: body.data.emoji,
  });
  if (!result.ok) {
    if (result.code === 'forbidden') return c.json({ error: result.error }, 403);
    return c.json({ error: result.error }, 500);
  }
  return c.json({ id: result.id }, result.added ? 201 : 200);
}

// ─── removeReaction ──────────────────────────────────────────────────────────

export async function handleRemoveReaction(c: HonoCtx) {
  const msgId = parseMessageId(c);
  if (!msgId.ok) return msgId.response;

  const parsed = reactionBodySchema.safeParse({
    conversationId: c.req.query('conversationId'),
    emoji: c.req.query('emoji'),
  });
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
  }

  const callerId = c.get('callerId');
  const result = await removeReactionFor(c.env, callerId, {
    conversationId: parsed.data.conversationId,
    messageId: msgId.data,
    emoji: parsed.data.emoji,
  });
  if (!result.ok) {
    if (result.code === 'forbidden') return c.json({ error: result.error }, 403);
    return c.json({ error: result.error }, 500);
  }
  return new Response(null, { status: 204 });
}

// ─── listMessages ────────────────────────────────────────────────────────────

export async function handleListMessages(c: HonoCtx) {
  const convId = parseConversationId(c);
  if (!convId.ok) return convId.response;

  const callerId = c.get('callerId');
  const convStub = c.env.CONVERSATION_DO.get(c.env.CONVERSATION_DO.idFromName(convId.data));

  if (!(await convStub.isMember(callerId))) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const beforeParam = c.req.query('before') || undefined;
  const limitParam = c.req.query('limit');
  const rawLimit = limitParam !== undefined ? Number(limitParam) : 50;
  const limit = Math.min(100, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 50));

  const result = await convStub.listMessages({ limit, before: beforeParam });
  return c.json({ messages: result.messages });
}

// ─── getMembers ──────────────────────────────────────────────────────────────

export async function handleGetMembers(c: HonoCtx) {
  const convId = parseConversationId(c);
  if (!convId.ok) return convId.response;

  const callerId = c.get('callerId');
  const convStub = c.env.CONVERSATION_DO.get(c.env.CONVERSATION_DO.idFromName(convId.data));

  const info = await convStub.getInfo();
  if (!info || !info.members.some(m => m.id === callerId)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  return c.json({ members: info.members });
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

// ─── renameConversation ─────────────────────────────────────────────────────

export async function handleRenameConversation(c: HonoCtx) {
  const convId = parseConversationId(c);
  if (!convId.ok) return convId.response;

  const body = await parseBody(c, renameConversationSchema);
  if (!body.ok) return body.response;

  const callerId = c.get('callerId');
  const result = await renameConversationFor(c.env, callerId, {
    conversationId: convId.data,
    title: body.data.title,
  });
  if (!result.ok) {
    return c.json({ error: result.error }, 403);
  }

  return c.json({ ok: true });
}
