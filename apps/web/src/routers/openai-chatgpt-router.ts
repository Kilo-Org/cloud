import 'server-only';

import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import type { User } from '@kilocode/db/schema';
import { baseProcedure, createTRPCRouter, type TRPCContext } from '@/lib/trpc/init';
import {
  clearOpenAiChatGptConnection,
  readOpenAiChatGptUsageLimit,
  getOpenAiChatGptConnection,
  openAiChatGptSharedServicesOwner,
  type OpenAiChatGptOwner,
} from '@/lib/ai-gateway/openai-chatgpt/store';
import {
  OpenAiChatGptStatusSchema,
  type OpenAiChatGptStatus,
} from '@/lib/ai-gateway/openai-chatgpt/status';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';

/**
 * The "Sign in with ChatGPT" BYOK connection. It is inherently personal: it is
 * owned by the signed-in person and scoped to one account, either their
 * personal account or one organization they belong to. Any member can manage
 * their own connection for an organization; it is their credential, not the
 * organization's. Both procedures return only `OpenAiChatGptStatus`: a token, a
 * refresh token and a raw OAuth error body are never part of the response.
 */

const OpenAiChatGptOwnerInputSchema = z.object({
  organizationId: z.uuid().optional(),
  /**
   * Set for the organization's shared-services connection: one connection per
   * organization, which only an owner or an admin may manage.
   */
  scope: z.literal('shared_services').optional(),
});

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

/**
 * Resolves the account the call operates on. The connection always belongs to
 * the signed-in person; an organization only selects which of their
 * connections applies. Any organization member can manage their own, so the
 * check requires membership, not a management role.
 */
async function resolveOwner(
  ctx: TRPCContext,
  organizationId: string | undefined,
  scope?: 'shared_services'
): Promise<OpenAiChatGptOwner> {
  const userId = requireUserId(ctx.user);
  if (!organizationId) {
    if (scope === 'shared_services') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'A shared-services connection needs an organization.',
      });
    }
    return { kiloUserId: userId, organizationId: null };
  }
  const role = await ensureOrganizationAccess(ctx, organizationId);
  if (scope === 'shared_services') {
    if (role !== 'owner' && role !== 'admin') {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Only an organization owner or admin can manage the shared-services connection.',
      });
    }
    return openAiChatGptSharedServicesOwner(organizationId);
  }
  return { kiloUserId: userId, organizationId };
}

/** An absent row is `disconnected`; a disabled row is `error` with its message. */
async function readStatus(owner: OpenAiChatGptOwner): Promise<OpenAiChatGptStatus> {
  const connection = await getOpenAiChatGptConnection(owner);
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

  // The plan limit is read only for a live connection: an errored connection
  // needs the reconnect message, not the usage-limit message.
  const usageLimit = await readOpenAiChatGptUsageLimit(owner);

  return {
    state: 'connected',
    ...identity,
    ...(usageLimit ? { usageLimit } : {}),
  };
}

export const openAiChatGptRouter = createTRPCRouter({
  status: baseProcedure
    .input(OpenAiChatGptOwnerInputSchema)
    .output(OpenAiChatGptStatusSchema)
    .query(
      async ({ ctx, input }): Promise<OpenAiChatGptStatus> =>
        readStatus(await resolveOwner(ctx, input.organizationId, input.scope))
    ),

  disconnect: baseProcedure
    .input(OpenAiChatGptOwnerInputSchema)
    .output(OpenAiChatGptStatusSchema)
    .mutation(async ({ ctx, input }): Promise<OpenAiChatGptStatus> => {
      const owner = await resolveOwner(ctx, input.organizationId, input.scope);
      await clearOpenAiChatGptConnection(owner);
      return readStatus(owner);
    }),
});
