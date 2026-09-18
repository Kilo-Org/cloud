import 'server-only';

import { TRPCError } from '@trpc/server';
import type { User } from '@kilocode/db/schema';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  clearOpenAiChatGptConnection,
  getOpenAiChatGptConnection,
} from '@/lib/ai-gateway/openai-chatgpt/store';
import {
  OpenAiChatGptStatusSchema,
  type OpenAiChatGptStatus,
} from '@/lib/ai-gateway/openai-chatgpt/status';

/**
 * The "Sign in with ChatGPT" BYOK connection, scoped to the signed-in user.
 *
 * Both procedures return only `OpenAiChatGptStatus`: a token, a refresh token
 * and a raw OAuth error body are never part of the response.
 */

/**
 * Authentication is enforced by the tRPC context for every real request; this
 * guard keeps the refusal explicit (and testable) when a caller reaches a
 * resolver without a user.
 */
function requireUserId(user: User | null | undefined): string {
  if (!user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'User not authenticated',
    });
  }
  return user.id;
}

/** An absent row is `disconnected`; a disabled row is `error` with its message. */
async function readStatus(userId: string): Promise<OpenAiChatGptStatus> {
  const connection = await getOpenAiChatGptConnection(userId);
  if (!connection) {
    return { state: 'disconnected' };
  }

  const identity = {
    ...(connection.email ? { email: connection.email } : {}),
    subject: connection.subject,
    connectedAt: connection.connected_at,
  };

  if (connection.status === 'error') {
    return {
      state: 'error',
      ...identity,
      ...(connection.error_message ? { errorMessage: connection.error_message } : {}),
    };
  }

  return { state: 'connected', ...identity };
}

export const openAiChatGptRouter = createTRPCRouter({
  status: baseProcedure
    .output(OpenAiChatGptStatusSchema)
    .query(({ ctx }): Promise<OpenAiChatGptStatus> => readStatus(requireUserId(ctx.user))),

  disconnect: baseProcedure
    .output(OpenAiChatGptStatusSchema)
    .mutation(async ({ ctx }): Promise<OpenAiChatGptStatus> => {
      const userId = requireUserId(ctx.user);
      await clearOpenAiChatGptConnection(userId);
      return readStatus(userId);
    }),
});
