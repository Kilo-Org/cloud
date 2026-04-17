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
import { createMessageFor, deleteMessageFor, editMessageFor } from '../services/messages';
import { addReactionFor, removeReactionFor } from '../services/reactions';
import { setTypingFor } from '../services/typing';
import {
  ulidSchema,
  createMessageSchema,
  editMessageSchema,
  deleteMessageSchema,
  reactionBodySchema,
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

/**
 * Options for create-message handler.
 * @param includeClientId - When true, echoes clientId in the 201 response
 *                          (human route behaviour). Bot route omits it.
 */
export function handleCreateMessage(includeClientId: boolean) {
  return async (c: HonoCtx) => {
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
    if (includeClientId) {
      return c.json(
        { messageId: result.messageId, ...(result.clientId ? { clientId: result.clientId } : {}) },
        201
      );
    }
    return c.json({ messageId: result.messageId }, 201);
  };
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

  const body = await parseBody(c, deleteMessageSchema);
  if (!body.ok) return body.response;

  const callerId = c.get('callerId');
  const result = await deleteMessageFor(c.env, callerId, {
    conversationId: body.data.conversationId,
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

  const body = await parseBody(c, reactionBodySchema);
  if (!body.ok) return body.response;

  const callerId = c.get('callerId');
  const result = await removeReactionFor(c.env, callerId, {
    conversationId: body.data.conversationId,
    messageId: msgId.data,
    emoji: body.data.emoji,
  });
  if (!result.ok) {
    if (result.code === 'forbidden') return c.json({ error: result.error }, 403);
    return c.json({ error: result.error }, 500);
  }
  return new Response(null, { status: 204 });
}

// ─── setTyping ───────────────────────────────────────────────────────────────

/**
 * @param successResponse - factory for the success response (human returns `{}`,
 *                          bot returns 204 No Content)
 */
export function handleSetTyping(successResponse: (c: HonoCtx) => Response) {
  return async (c: HonoCtx) => {
    const convId = parseConversationId(c);
    if (!convId.ok) return convId.response;

    const callerId = c.get('callerId');
    const result = await setTypingFor(c.env, callerId, { conversationId: convId.data });
    if (!result.ok) {
      return c.json({ error: result.error }, 403);
    }
    return successResponse(c);
  };
}
