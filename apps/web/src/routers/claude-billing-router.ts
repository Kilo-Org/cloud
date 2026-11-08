import 'server-only';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { claude_billing_connections, type ClaudeBillingConnectionRow } from '@kilocode/db/schema';
import {
  CLAUDE_BILLING_PROVIDER_ID,
  CLAUDE_BILLING_PROVIDER_NAME,
} from '@kilocode/web-shared/lib/ai-gateway/claude-billing/provider-id';
import { getClaudeBillingConnection } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';
import type { ClaudeBillingOwner } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';
import { ClaudeBillingConnectionStatus } from '@kilocode/db/schema-types';
import {
  baseProcedure,
  createTRPCRouter,
  type TRPCContext,
} from '@kilocode/web-shared/lib/trpc/init';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { canManageOrganization } from '@kilocode/app-shared/organizations';

/**
 * The owner's Claude billing connection: one Kilo organization connection or
 * the person's own. Only an organization owner or admin manages the
 * organization's connection.
 */

const ClaudeBillingOwnerInputSchema = z.object({
  organizationId: z.uuid().optional(),
});

export const ClaudeBillingStatusSchema = z.object({
  state: z.enum(['not_connected', 'connected', 'billing_unavailable', 'pending']),
  connectedAt: z.string().nullable(),
  /** Anthropic's refusal code for the last refused request, when one applied. */
  lastRefusalCode: z.string().nullable(),
  providerId: z.literal(CLAUDE_BILLING_PROVIDER_ID),
  providerName: z.literal(CLAUDE_BILLING_PROVIDER_NAME),
  /** Whether the signed-in person may start or remove the connection. */
  canManage: z.boolean(),
});

export type ClaudeBillingStatus = z.infer<typeof ClaudeBillingStatusSchema>;

async function resolveOwner(
  ctx: TRPCContext,
  organizationId: string | undefined
): Promise<{ owner: ClaudeBillingOwner; canManage: boolean }> {
  if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'User not authenticated' });
  if (!organizationId) {
    return { owner: { kind: 'personal', kiloUserId: ctx.user.id }, canManage: true };
  }
  const role = await ensureOrganizationAccess(ctx, organizationId);
  return {
    owner: { kind: 'organization', organizationId },
    canManage: canManageOrganization(role),
  };
}

function statusOf(row: ClaudeBillingConnectionRow | null, canManage: boolean): ClaudeBillingStatus {
  const base = {
    providerId: CLAUDE_BILLING_PROVIDER_ID,
    providerName: CLAUDE_BILLING_PROVIDER_NAME,
    canManage,
    connectedAt: row?.connected_at ? new Date(row.connected_at).toISOString() : null,
    lastRefusalCode: row?.last_refusal_code ?? null,
  } as const;
  switch (row?.status) {
    case ClaudeBillingConnectionStatus.Connected:
      return { ...base, state: 'connected' };
    case ClaudeBillingConnectionStatus.BillingUnavailable:
      return { ...base, state: 'billing_unavailable' };
    case ClaudeBillingConnectionStatus.Pending:
      return { ...base, state: 'pending' };
    default:
      return { ...base, state: 'not_connected' };
  }
}

export const claudeBillingRouter = createTRPCRouter({
  status: baseProcedure
    .input(ClaudeBillingOwnerInputSchema)
    .output(ClaudeBillingStatusSchema)
    .query(async ({ ctx, input }): Promise<ClaudeBillingStatus> => {
      const { owner, canManage } = await resolveOwner(ctx, input.organizationId);
      return statusOf(await getClaudeBillingConnection(owner), canManage);
    }),

  remove: baseProcedure
    .input(ClaudeBillingOwnerInputSchema)
    .output(ClaudeBillingStatusSchema)
    .mutation(async ({ ctx, input }): Promise<ClaudeBillingStatus> => {
      const { owner, canManage } = await resolveOwner(ctx, input.organizationId);
      if (!canManage) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only an organization owner or admin can remove the link.',
        });
      }
      // The profile stays: Anthropic allows one per customer organization, and a
      // reconnect reuses it. The connection stops billing from now on.
      await db
        .update(claude_billing_connections)
        .set({
          status: ClaudeBillingConnectionStatus.Removed,
          connection_id: null,
          connected_at: null,
          last_refusal_code: null,
          last_refusal_at: null,
        })
        .where(
          owner.kind === 'organization'
            ? eq(claude_billing_connections.organization_id, owner.organizationId)
            : eq(claude_billing_connections.kilo_user_id, owner.kiloUserId)
        );
      return statusOf(await getClaudeBillingConnection(owner), canManage);
    }),
});
