import 'server-only';
import { TRPCError } from '@trpc/server';
import {
  ORGANIZATION_BILLING_ROLES,
  ORGANIZATION_MANAGE_ROLES,
} from '@kilocode/app-shared/organizations';
import { enqueueInviteEmail } from '@kilocode/db/external-side-effect-outbox';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import type { TRPCContext } from '@/lib/trpc/init';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import type { OrganizationRole } from './organization-types';
import { createAuditLog } from './organization-audit-logs';
import { getAcceptInviteUrl, getOrganizationById, inviteUserToOrganization } from './organizations';
import { requireActiveSubscriptionOrTrial } from './trial-middleware';

/** Reuse the complete authorized operation, including when a harness transaction owns the commit. */
export async function inviteOrganizationMember(
  ctx: TRPCContext,
  input: { organizationId: string; email: string; role: OrganizationRole },
  transaction?: DrizzleTransaction
) {
  const { user } = ctx;
  const { organizationId, email, role } = input;
  // Legacy router middleware checks these before validating the remaining input. Keep that ordering
  // until old web/native invitation clients retire; resumed calls must also check independently.
  await ensureOrganizationAccess(ctx, organizationId, ORGANIZATION_BILLING_ROLES, transaction);
  await requireActiveSubscriptionOrTrial(organizationId, transaction);
  if (role !== 'member') {
    const actorRole = await ensureOrganizationAccess(
      ctx,
      organizationId,
      ORGANIZATION_MANAGE_ROLES,
      transaction
    );
    if (role === 'owner' && actorRole !== 'owner') {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Only an organization owner can manage owners',
      });
    }
  }

  const organization = await getOrganizationById(organizationId, transaction);
  if (!organization) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
  }

  try {
    const run = async (tx: DrizzleTransaction) => {
      const invitation = await inviteUserToOrganization(organizationId, user.id, email, role, tx);
      const acceptInviteUrl = getAcceptInviteUrl(invitation.token);
      await createAuditLog({
        action: 'organization.user.send_invite',
        actor_email: user.google_user_email,
        actor_id: user.id,
        actor_name: user.google_user_name,
        message: `Invited ${email} as ${role}`,
        organization_id: organization.id,
        tx,
      });
      await enqueueInviteEmail(tx, {
        invitationId: invitation.id,
        payload: {
          invitationId: invitation.id,
          to: email,
          organizationName: organization.name,
          inviterName: user.google_user_name,
          acceptInviteUrl,
        },
      });
      return { acceptInviteUrl, invitationId: invitation.id, emailStatus: 'pending' as const };
    };
    return transaction ? await run(transaction) : await db.transaction(run);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === 'User already has a pending invitation') {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'This email already has a pending invitation',
        });
      }
      if (error.message === 'User is already a member of this organization') {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'This user is already a member of this organization',
        });
      }
      if (error.message === 'Child organizations cannot invite members') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Child organizations manage membership through their parent organization.',
        });
      }
      if (error.message === 'User must join this organization through SSO') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'This user must join through your organization SSO provider',
        });
      }
      if (error.message === 'Organization SSO policy is misconfigured') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This organization has an invalid SSO configuration',
        });
      }
    }
    throw error;
  }
}
