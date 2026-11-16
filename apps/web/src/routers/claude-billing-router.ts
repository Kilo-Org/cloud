import 'server-only';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { type ClaudeBillingConnectionRow } from '@kilocode/db/schema';
import {
  CLAUDE_BILLING_PROVIDER_ID,
  CLAUDE_BILLING_PROVIDER_NAME,
} from '@kilocode/web-shared/lib/ai-gateway/claude-billing/provider-id';
import {
  ClaudeBillingShareError,
  claudeBillingOwnerKey,
  describeClaudeBillingSharing,
  getGrantedClaudeBillingConnection,
  shareClaudeBillingConnection,
  type ClaudeBillingOwner,
  type ClaudeBillingScopeSharing,
} from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';
import { isClaudePlatformOAuthEnabled } from '@kilocode/web-shared/lib/auth/claude/feature-flag.server';
import {
  baseProcedure,
  createTRPCRouter,
  type TRPCContext,
} from '@kilocode/web-shared/lib/trpc/init';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { canManageOrganization } from '@kilocode/app-shared/organizations';
import {
  claudeBillingConnectionState,
  type ClaudeBillingConnectionState,
} from '@/lib/claude-billing/profile';
import {
  retireUnreferencedClaudeBillingPayer,
  unlinkAndRemoveClaudeBillingGrant,
} from '@/lib/claude-billing/delete';
/**
 * The caller's Claude billing connections: their personal one, and the
 * connection of an organization they belong to. A person manages their own
 * connection. An organization's connection serves every request in it, so only
 * an organization owner or admin manages it, while any member may read it.
 */

export const ClaudeBillingOwnerInputSchema = z.object({
  organizationId: z.uuid().optional(),
});

export const ClaudeBillingShareableLinkSchema = z.object({
  payerId: z.uuid(),
  source: ClaudeBillingOwnerInputSchema,
  label: z.string().min(1),
  connectedAt: z.string().nullable(),
});

export const ClaudeBillingShareInputSchema = z.object({
  source: ClaudeBillingOwnerInputSchema,
  target: ClaudeBillingOwnerInputSchema,
});

export const ClaudeBillingStatusSchema = z.object({
  state: z.enum([
    'not_connected',
    'connected',
    'billing_unavailable',
    'pending',
    'reconnect_required',
  ]),
  connectedAt: z.string().nullable(),
  /** Anthropic's refusal code for the last refused request, when one applied. */
  lastRefusalCode: z.string().nullable(),
  providerId: z.literal(CLAUDE_BILLING_PROVIDER_ID),
  providerName: z.literal(CLAUDE_BILLING_PROVIDER_NAME),
  /** Whether the signed-in person may start or remove the connection. */
  canManage: z.boolean(),
  /** Whether this scope can use the person's connected personal payer. */
  canSharePersonal: z.boolean(),
  /** Connected Claude links controlled by the caller that can be shared to this scope. */
  shareableLinks: z.array(ClaudeBillingShareableLinkSchema),
  /** Other scopes visible to the caller that share this scope's active payer. */
  sharedWith: z.array(z.string()),
});

export type ClaudeBillingStatus = z.infer<typeof ClaudeBillingStatusSchema>;
async function resolveOwner(
  ctx: TRPCContext,
  organizationId: string | undefined
): Promise<{
  userId: string;
  userEmail: string | null;
  owner: ClaudeBillingOwner;
  canManage: boolean;
}> {
  if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'User not authenticated' });
  const userId = ctx.user.id;
  const userEmail = ctx.user.google_user_email;
  if (!organizationId) {
    return { userId, userEmail, owner: { kind: 'personal', kiloUserId: userId }, canManage: true };
  }
  const role = await ensureOrganizationAccess(ctx, organizationId);
  return {
    userId,
    userEmail,
    owner: { kind: 'organization', organizationId },
    canManage: canManageOrganization(role),
  };
}

function statusOf(
  row: ClaudeBillingConnectionRow | null,
  canManage: boolean,
  state: ClaudeBillingConnectionState,
  sharing: ClaudeBillingScopeSharing = { shareableLinks: [], sharedWith: [] }
): ClaudeBillingStatus {
  const canSharePersonal = sharing.shareableLinks.some(
    link => link.source.organizationId === undefined
  );
  return {
    providerId: CLAUDE_BILLING_PROVIDER_ID,
    providerName: CLAUDE_BILLING_PROVIDER_NAME,
    canManage,
    canSharePersonal,
    shareableLinks: sharing.shareableLinks,
    sharedWith: sharing.sharedWith,
    connectedAt: row?.connected_at ? new Date(row.connected_at).toISOString() : null,
    lastRefusalCode: row?.last_refusal_code ?? null,
    state,
  };
}

async function buildScopeStatus(
  userId: string,
  owner: ClaudeBillingOwner,
  canManage: boolean
): Promise<ClaudeBillingStatus> {
  const current = await getGrantedClaudeBillingConnection(owner);
  const [sharing, state] = await Promise.all([
    describeClaudeBillingSharing(userId, owner, canManage, current),
    claudeBillingConnectionState(owner, current),
  ]);
  return statusOf(current, canManage, state, sharing);
}

function forbiddenManageMessage(owner: ClaudeBillingOwner): string {
  return owner.kind === 'organization'
    ? 'Only an organization owner or admin with access to this feature can link it.'
    : 'Linked billing with Claude Platform is not available for your account yet.';
}

async function executeShare(
  ctx: TRPCContext,
  sourceInput: z.infer<typeof ClaudeBillingOwnerInputSchema>,
  targetInput: z.infer<typeof ClaudeBillingOwnerInputSchema>
): Promise<ClaudeBillingStatus> {
  const targetResolved = await resolveOwner(ctx, targetInput.organizationId);
  if (ctx.authViaToken || ctx.credential !== 'session') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Share a Claude link from the Kilo web app.',
    });
  }
  const sourceResolved = await resolveOwner(ctx, sourceInput.organizationId);
  if (claudeBillingOwnerKey(sourceResolved.owner) === claudeBillingOwnerKey(targetResolved.owner)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Select another scope to share its Claude link.',
    });
  }
  if (
    !sourceResolved.canManage ||
    !targetResolved.canManage ||
    !(await isClaudePlatformOAuthEnabled(targetResolved.userEmail))
  ) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: forbiddenManageMessage(
        !targetResolved.canManage ? targetResolved.owner : sourceResolved.owner
      ),
    });
  }
  try {
    await shareClaudeBillingConnection(
      sourceResolved.owner,
      targetResolved.owner,
      targetResolved.userId
    );
    return await buildScopeStatus(
      targetResolved.userId,
      targetResolved.owner,
      targetResolved.canManage
    );
  } catch (error) {
    if (error instanceof ClaudeBillingShareError) {
      if (error.reason === 'source_forbidden') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only the person who linked that Claude organization can share it.',
        });
      }
      throw new TRPCError({
        code: error.reason === 'target_connected' ? 'CONFLICT' : 'PRECONDITION_FAILED',
        message:
          error.reason === 'target_connected'
            ? 'This scope already has a Claude link. Remove it from Kilo first.'
            : 'Link a Claude organization first, then share it here.',
      });
    }
    throw error;
  }
}

export const claudeBillingRouter = createTRPCRouter({
  status: baseProcedure
    .input(ClaudeBillingOwnerInputSchema)
    .output(ClaudeBillingStatusSchema)
    .query(async ({ ctx, input }): Promise<ClaudeBillingStatus> => {
      const { userId, owner, canManage } = await resolveOwner(ctx, input.organizationId);
      return await buildScopeStatus(userId, owner, canManage);
    }),

  share: baseProcedure
    .input(ClaudeBillingShareInputSchema)
    .output(ClaudeBillingStatusSchema)
    .mutation(async ({ ctx, input }): Promise<ClaudeBillingStatus> => {
      return await executeShare(ctx, input.source, input.target);
    }),

  sharePersonal: baseProcedure
    .input(ClaudeBillingOwnerInputSchema)
    .output(ClaudeBillingStatusSchema)
    .mutation(async ({ ctx, input }): Promise<ClaudeBillingStatus> => {
      if (!input.organizationId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Select an organization scope to share your personal Claude link.',
        });
      }
      return await executeShare(ctx, {}, input);
    }),

  remove: baseProcedure
    .input(ClaudeBillingOwnerInputSchema)
    .output(ClaudeBillingStatusSchema)
    .mutation(async ({ ctx, input }): Promise<ClaudeBillingStatus> => {
      const { userId, owner, canManage } = await resolveOwner(ctx, input.organizationId);
      if (!canManage) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only an organization owner or admin can remove the organization link.',
        });
      }
      const removal = await unlinkAndRemoveClaudeBillingGrant(owner);
      if (removal.unlink.kind === 'retry') {
        throw new TRPCError({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Anthropic did not confirm the unlink. Try again.',
        });
      }
      if (removal.unlink.kind === 'needs_console') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Unlink Kilo under Linked platforms in Claude Console, then remove it here.',
        });
      }
      const unreferencedPayer = removal.unreferencedPayer;
      if (unreferencedPayer) {
        await retireUnreferencedClaudeBillingPayer(unreferencedPayer).catch(error => {
          console.error('[claude-billing] remote profile retirement deferred', {
            error: error instanceof Error ? error.name : 'unknown',
          });
        });
      }
      return await buildScopeStatus(userId, owner, canManage);
    }),
});
