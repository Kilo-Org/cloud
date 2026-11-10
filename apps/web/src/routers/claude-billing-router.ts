import 'server-only';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { type ClaudeBillingConnectionRow } from '@kilocode/db/schema';
import {
  CLAUDE_BILLING_PROVIDER_ID,
  CLAUDE_BILLING_PROVIDER_NAME,
} from '@kilocode/web-shared/lib/ai-gateway/claude-billing/provider-id';
import {
  getGrantedClaudeBillingConnection,
  removeClaudeBillingGrant,
} from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';
import type { ClaudeBillingOwner } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';
import { ClaudeBillingConnectionStatus } from '@kilocode/db/schema-types';
import {
  baseProcedure,
  createTRPCRouter,
  type TRPCContext,
} from '@kilocode/web-shared/lib/trpc/init';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { canManageOrganization } from '@kilocode/app-shared/organizations';
import { isClaudeBillingOrganizationMember } from '@/lib/claude-billing/access';

/**
 * The caller's Claude billing connections: their personal one, their own in an
 * organization, and the organization's shared-services one. A person manages
 * their own connections. The shared-services connection is an organization
 * setting, so only an organization owner or admin manages it.
 */

const ClaudeBillingOwnerInputSchema = z.object({
  organizationId: z.uuid().optional(),
  /** `shared_services` reads and manages the organization's service connection. */
  scope: z.literal('shared_services').optional(),
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
  /** Whether this scope can use the person's connected personal payer. */
  canSharePersonal: z.boolean(),
});

export type ClaudeBillingStatus = z.infer<typeof ClaudeBillingStatusSchema>;

async function resolveOwner(
  ctx: TRPCContext,
  organizationId: string | undefined,
  scope: 'shared_services' | undefined
): Promise<{ owner: ClaudeBillingOwner; canManage: boolean }> {
  if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'User not authenticated' });
  const userId = ctx.user.id;
  if (!organizationId) {
    if (scope === 'shared_services') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'A shared-services connection needs an organization.',
      });
    }
    return { owner: { kind: 'personal', kiloUserId: userId }, canManage: true };
  }
  const role = await ensureOrganizationAccess(ctx, organizationId);
  if (scope === 'shared_services') {
    return {
      owner: { kind: 'shared_services', organizationId },
      canManage: canManageOrganization(role),
    };
  }
  return {
    owner: { kind: 'member', kiloUserId: userId, organizationId },
    // A member connection needs a direct membership, which inherited access is not.
    canManage: await isClaudeBillingOrganizationMember(userId, organizationId),
  };
}

function statusOf(
  row: ClaudeBillingConnectionRow | null,
  canManage: boolean,
  canSharePersonal = false
): ClaudeBillingStatus {
  const base = {
    providerId: CLAUDE_BILLING_PROVIDER_ID,
    providerName: CLAUDE_BILLING_PROVIDER_NAME,
    canManage,
    canSharePersonal,
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

async function maySharePersonal(
  userId: string,
  owner: ClaudeBillingOwner,
  canManage: boolean,
  current: ClaudeBillingConnectionRow | null
): Promise<boolean> {
  if (owner.kind === 'personal' || !canManage) return false;
  if (
    current &&
    current.status !== ClaudeBillingConnectionStatus.Removed &&
    current.status !== ClaudeBillingConnectionStatus.Pending
  ) {
    return false;
  }
  const personal = await getGrantedClaudeBillingConnection({
    kind: 'personal',
    kiloUserId: userId,
  });
  return personal?.status === ClaudeBillingConnectionStatus.Connected;
}

export const claudeBillingRouter = createTRPCRouter({
  status: baseProcedure
    .input(ClaudeBillingOwnerInputSchema)
    .output(ClaudeBillingStatusSchema)
    .query(async ({ ctx, input }): Promise<ClaudeBillingStatus> => {
      const { owner, canManage } = await resolveOwner(ctx, input.organizationId, input.scope);
      if (!ctx.user)
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'User not authenticated' });
      const current = await getGrantedClaudeBillingConnection(owner);
      return statusOf(
        current,
        canManage,
        await maySharePersonal(ctx.user.id, owner, canManage, current)
      );
    }),

  remove: baseProcedure
    .input(ClaudeBillingOwnerInputSchema)
    .output(ClaudeBillingStatusSchema)
    .mutation(async ({ ctx, input }): Promise<ClaudeBillingStatus> => {
      const { owner, canManage } = await resolveOwner(ctx, input.organizationId, input.scope);
      if (!canManage) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message:
            owner.kind === 'shared_services'
              ? 'Only an organization owner or admin can remove the shared-services link.'
              : 'Only a direct member of this organization can manage their own link.',
        });
      }
      await removeClaudeBillingGrant(owner);
      return statusOf(await getGrantedClaudeBillingConnection(owner), canManage);
    }),
});
