import { z } from 'zod';
import { contentBlockSchema, ulidSchema, emojiSchema } from './routes/schemas';
import { createMessageFor, editMessageFor, deleteMessageFor } from './services/messages';
import { addReactionFor, removeReactionFor } from './services/reactions';
import { setTypingFor } from './services/typing';
import {
  createConversationFor,
  renameConversationFor,
  leaveConversationFor,
  markReadFor,
} from './services/conversations';

export type RpcError = Error & { code: number };

function rpcError(code: number, message: string): RpcError {
  const err = new Error(message) as RpcError;
  err.code = code;
  return err;
}

// ─── Zod schemas for RPC payloads ──────────────────────────────────────────

const SANDBOX_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const sendMessagePayload = z.object({
  conversationId: ulidSchema,
  content: z.array(contentBlockSchema).min(1).max(20),
  inReplyToMessageId: ulidSchema.optional(),
  clientId: ulidSchema.optional(),
});

const editMessagePayload = z.object({
  conversationId: ulidSchema,
  messageId: ulidSchema,
  content: z.array(contentBlockSchema).min(1).max(20),
  timestamp: z.number().int().positive(),
});

const deleteMessagePayload = z.object({
  conversationId: ulidSchema,
  messageId: ulidSchema,
});

const sendTypingPayload = z.object({
  conversationId: ulidSchema,
});

const createConversationPayload = z.object({
  sandboxId: z.string().regex(SANDBOX_ID_PATTERN, 'Invalid sandboxId'),
  title: z.string().max(200).optional(),
});

const renameConversationPayload = z.object({
  conversationId: ulidSchema,
  title: z.string().min(1).max(200),
});

const leaveConversationPayload = z.object({
  conversationId: ulidSchema,
});

const markReadPayload = z.object({
  conversationId: ulidSchema,
});

const addReactionPayload = z.object({
  conversationId: ulidSchema,
  messageId: ulidSchema,
  emoji: emojiSchema,
});

const removeReactionPayload = z.object({
  conversationId: ulidSchema,
  messageId: ulidSchema,
  emoji: emojiSchema,
});

// ─── helpers ───────────────────────────────────────────────────────────────

function validate<T>(schema: z.ZodSchema<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw rpcError(400, `Invalid payload: ${result.error.issues.map(i => i.message).join(', ')}`);
  }
  return result.data;
}

// ─── dispatcher ────────────────────────────────────────────────────────────

export async function dispatchRpc(
  env: Env,
  userId: string,
  method: string,
  payload: unknown
): Promise<unknown> {
  switch (method) {
    case 'sendMessage': {
      const p = validate(sendMessagePayload, payload);
      const result = await createMessageFor(env, userId, p, undefined);
      if (!result.ok) throw rpcError(result.code === 'forbidden' ? 403 : 500, result.error);
      return { messageId: result.messageId, clientId: result.clientId };
    }

    case 'editMessage': {
      const p = validate(editMessagePayload, payload);
      const result = await editMessageFor(env, userId, p);
      if (!result.ok) {
        const code = result.code === 'forbidden' ? 403 : result.code === 'not_found' ? 404 : 500;
        throw rpcError(code, result.error);
      }
      if (result.stale) throw rpcError(409, 'Edit conflict');
      return { messageId: result.messageId };
    }

    case 'deleteMessage': {
      const p = validate(deleteMessagePayload, payload);
      const result = await deleteMessageFor(env, userId, p);
      if (!result.ok) {
        const code = result.code === 'forbidden' ? 403 : result.code === 'not_found' ? 404 : 500;
        throw rpcError(code, result.error);
      }
      return { ok: true };
    }

    case 'sendTyping': {
      const p = validate(sendTypingPayload, payload);
      const result = await setTypingFor(env, userId, p);
      if (!result.ok) throw rpcError(403, result.error);
      return { ok: true };
    }

    case 'createConversation': {
      const p = validate(createConversationPayload, payload);
      // RPC path is trusted — no allowedSandboxIds check
      const result = await createConversationFor(env, userId, p);
      if (!result.ok) {
        throw rpcError(result.code === 'forbidden' ? 403 : 500, result.error);
      }
      return { conversationId: result.conversationId };
    }

    case 'renameConversation': {
      const p = validate(renameConversationPayload, payload);
      const result = await renameConversationFor(env, userId, p);
      if (!result.ok) throw rpcError(403, result.error);
      return { ok: true };
    }

    case 'leaveConversation': {
      const p = validate(leaveConversationPayload, payload);
      const result = await leaveConversationFor(env, userId, p);
      if (!result.ok) throw rpcError(403, result.error);
      return { ok: true };
    }

    case 'markRead': {
      const p = validate(markReadPayload, payload);
      const result = await markReadFor(env, userId, p);
      if (!result.ok) throw rpcError(403, result.error);
      return { ok: true };
    }

    case 'addReaction': {
      const p = validate(addReactionPayload, payload);
      const result = await addReactionFor(env, userId, p);
      if (!result.ok) {
        throw rpcError(result.code === 'forbidden' ? 403 : 500, result.error);
      }
      return { id: result.id, added: result.added };
    }

    case 'removeReaction': {
      const p = validate(removeReactionPayload, payload);
      const result = await removeReactionFor(env, userId, p);
      if (!result.ok) {
        throw rpcError(result.code === 'forbidden' ? 403 : 500, result.error);
      }
      return { ok: true };
    }

    default:
      throw rpcError(404, `Unknown method: ${method}`);
  }
}
