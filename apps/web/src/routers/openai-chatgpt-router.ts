import 'server-only';

import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import type { User } from '@kilocode/db/schema';
import {
  baseProcedure,
  createTRPCRouter,
  type TRPCContext,
} from '@kilocode/web-shared/lib/trpc/init';
import {
  clearOpenAiChatGptConnection,
  readOpenAiChatGptUsageLimit,
  getOpenAiChatGptConnection,
  getOpenAiChatGptStoredConnectionFromPrimary,
  openAiChatGptSharedServicesOwner,
  type OpenAiChatGptOwner,
} from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/store';
import { openAiChatGptConnectorGone } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/connector';
import { OPENAI_CHATGPT_SHARED_RECONNECT_MESSAGE } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { OpenAiChatGptStatusSchema, type OpenAiChatGptStatus } from '@/lib/openai-chatgpt/status';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';

/**
 * The "Sign in with ChatGPT" BYOK connection. A member's connection is
 * inherently personal: it is owned by the signed-in person and scoped to one
 * account, either their personal account or one organization they belong to.
 * Any member can manage their own connection for an organization; it is their
 * credential, not the organization's. An organization also has one
 * shared-services connection, which only an owner or admin may manage and which
 * Kilo's shared services use. Its status reports `reconnect_required` while the
 * account that connected it is gone, because only an organization owner or
 * admin can reconnect it. Both procedures return only `OpenAiChatGptStatus`: a
 * token, a refresh token and a raw OAuth error body are never part of the
 * response.
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

/**
 * An absent row is `disconnected`; a disabled row is `error` with its message;
 * a live shared-services row whose connector account is gone is
 * `reconnect_required`, because only an organization owner or admin can
 * reconnect it.
 *
 * The payload is read on the primary through `getOpenAiChatGptConnection`, so a
 * terminal refresh failure surfaces its reconnect message and a completed
 * disconnect is reflected at once. Only the shared-services owner adds a second
 * read, `getOpenAiChatGptStoredConnectionFromPrimary`, for the `createdBy` the
 * connector decision needs. The connector account lookup also takes the
 * primary, so the row and the account it names come from the same database and
 * the answer follows the row an owner just saved. Every other owner reads once.
 */
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

  // Only an organization's shared-services connection names a connector whose
  // absence the organization must fix; a personal or member connection is the
  // caller's own and is never checked for it.
  if (owner.scope === 'shared_services') {
    const stored = await getOpenAiChatGptStoredConnectionFromPrimary(owner);
    if (stored && (await openAiChatGptConnectorGone(stored, db))) {
      return {
        state: 'reconnect_required',
        ...identity,
        errorMessage: OPENAI_CHATGPT_SHARED_RECONNECT_MESSAGE,
      };
    }
  }

  // The plan limit is read only for a live connection: an errored connection
  // needs the reconnect message, not the usage-limit message, and a connection
  // whose connector is gone resumes under a new connector.
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
    .query(async ({ ctx, input }): Promise<OpenAiChatGptStatus> =>
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
