import {
  updateUserRoleInOrganization,
  removeUserFromOrganization,
  getOrganizationById,
  inviteUserToOrganization,
  getAcceptInviteUrl,
} from '@/lib/organizations/organizations';
import { updateOrganizationUserLimit } from '@/lib/organizations/organization-usage';
import {
  organization_memberships,
  organization_invitations,
  kilocode_users,
} from '@kilocode/db/schema';
import { db, sql } from '@/lib/drizzle';
import { createTRPCRouter } from '@/lib/trpc/init';
import {
  OrganizationIdInputSchema,
  organizationOwnerProcedure,
} from '@/routers/organizations/utils';
import { sendOrganizationInviteEmail } from '@/lib/email';
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import * as z from 'zod';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { findUserById } from '@/lib/user';
import { successResult } from '@/lib/maybe-result';
import { requireActiveSubscriptionOrTrial } from '@/lib/organizations/trial-middleware';

const MAX_DAILY_LIMIT_USD = 2000;

const UpdateMemberSchema = OrganizationIdInputSchema.extend({
  memberId: z.string(),
  role: z.enum(['owner', 'member', 'billing_manager']).optional(),
  dailyUsageLimitUsd: z.number().min(0).max(MAX_DAILY_LIMIT_USD).nullable().optional(),
});

const RemoveMemberSchema = OrganizationIdInputSchema.extend({
  memberId: z.string(),
});

const InviteMemberSchema = OrganizationIdInputSchema.extend({
  email: z.email('Invalid email address'),
  role: z.enum(['owner', 'member', 'billing_manager']),
});

const DeleteInviteSchema = OrganizationIdInputSchema.extend({
  inviteId: z.string(),
});

export const organizationsMembersRouter = createTRPCRouter({
  update: organizationOwnerProcedure.input(UpdateMemberSchema).mutation(async ({ input, ctx }) => {
    const { user } = ctx;
    const { organizationId, memberId, role, dailyUsageLimitUsd } = input;

    await requireActiveSubscriptionOrTrial(organizationId);

    // Get the target user's role if we need to check permissions for role or limit changes
    let targetMember: { role: string } | undefined;
    if (role !== undefined || dailyUsageLimitUsd !== undefined) {
      const [member] = await db
        .select({ role: organization_memberships.role })
        .from(organization_memberships)
        .where(
          and(
            eq(organization_memberships.organization_id, organizationId),
            eq(organization_memberships.kilo_user_id, memberId)
          )
        );

      if (!member) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User is not a member of this organization',
        });
      }

      targetMember = member;
    }

    // Handle role update if provided
    if (role !== undefined) {
      // Prevent users from changing their own role
      if (user.id === memberId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You cannot change your own role',
        });
      }

      const result = await updateUserRoleInOrganization(organizationId, memberId, role);
      const updatedUser = await findUserById(memberId);
      const updatedUserEmail = updatedUser?.google_user_email || 'unknown';
      await createAuditLog({
        action: 'organization.member.change_role',
        actor_email: user.google_user_email,
        actor_id: user.id,
        actor_name: user.google_user_name,
        message: `Changed role for user ${updatedUserEmail} from ${targetMember?.role} to ${role}`,
        organization_id: organizationId,
      });

      if (!result.success) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Failed to update user role',
        });
      }
    }

    // Handle daily usage limit update if provided
    if (dailyUsageLimitUsd !== undefined && targetMember) {
      await updateOrganizationUserLimit(organizationId, memberId, dailyUsageLimitUsd);
    }

    return successResult({
      updated: role !== undefined ? 'role and limit' : 'limit',
    });
  }),
  remove: organizationOwnerProcedure.input(RemoveMemberSchema).mutation(async ({ input, ctx }) => {
    const { user } = ctx;
    const { organizationId, memberId } = input;

    await requireActiveSubscriptionOrTrial(organizationId);

    // Prevent users from removing themselves (unless they are kilo admin users)
    if (user.id === memberId && !user.is_admin) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'You cannot remove yourself from the organization',
      });
    }

    // Get the target user's role and bot status
    const [targetMember] = await db
      .select({
        role: organization_memberships.role,
        isBot: kilocode_users.is_bot,
      })
      .from(organization_memberships)
      .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
      .where(
        and(
          eq(organization_memberships.organization_id, organizationId),
          eq(organization_memberships.kilo_user_id, memberId)
        )
      );

    if (!targetMember) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'User is not a member of this organization',
      });
    }

    // Prevent removal of bot users
    if (targetMember.isBot) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Service account users cannot be removed',
      });
    }

    const result = await removeUserFromOrganization(organizationId, memberId);
    const removedUser = await findUserById(memberId);
    await createAuditLog({
      action: 'organization.member.remove',
      actor_email: user.google_user_email,
      actor_id: user.id,
      actor_name: user.google_user_name,
      message: `Removed user ${removedUser?.google_user_email || 'unknown'}`,
      organization_id: organizationId,
    });

    if (result.rowCount === 0) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Failed to remove user from organization',
      });
    }

    return successResult({ updated: memberId });
  }),
  invite: organizationOwnerProcedure.input(InviteMemberSchema).mutation(async ({ input, ctx }) => {
    const { user } = ctx;
    const { organizationId, email, role } = input;

    await requireActiveSubscriptionOrTrial(organizationId);

    // Get organization details
    const organization = await getOrganizationById(organizationId);
    if (!organization) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Organization not found',
      });
    }

    // Owners and Kilo admins can invite anyone (owner or member)
    let invitation;
    try {
      invitation = await inviteUserToOrganization(organizationId, user.id, email, role);
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
      }
      throw error;
    }
    const acceptInviteUrl = getAcceptInviteUrl(invitation.token);

    const emailResult = await sendOrganizationInviteEmail({
      to: email,
      organizationName: organization.name,
      inviterName: user.google_user_name,
      acceptInviteUrl,
    });

    if (!emailResult.sent) {
      // Expire the invitation so it doesn't block future invites to the same email
      await db
        .update(organization_invitations)
        .set({ expires_at: sql`NOW()` })
        .where(eq(organization_invitations.id, invitation.id));
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          'Unable to deliver the invitation email to this address. Please use a different email.',
      });
    }

    await createAuditLog({
      action: 'organization.user.send_invite',
      actor_email: user.google_user_email,
      actor_id: user.id,
      actor_name: user.google_user_name,
      message: `Invited ${email} as ${role}`,
      organization_id: organization.id,
    });

    return {
      acceptInviteUrl,
    };
  }),
  deleteInvite: organizationOwnerProcedure
    .input(DeleteInviteSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId, inviteId } = input;

      await requireActiveSubscriptionOrTrial(organizationId);

      // Find the invitation
      const [invitation] = await db
        .select()
        .from(organization_invitations)
        .where(
          and(
            eq(organization_invitations.id, inviteId),
            eq(organization_invitations.organization_id, organizationId)
          )
        )
        .limit(1);

      if (!invitation) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Invitation not found',
        });
      }

      // Owners can delete any invitation
      // Expire the invitation by setting expires_at to NOW
      await db
        .update(organization_invitations)
        .set({ expires_at: sql`NOW()` })
        .where(eq(organization_invitations.id, inviteId));

      await createAuditLog({
        action: 'organization.user.revoke_invite',
        actor_email: ctx.user.google_user_email,
        actor_id: ctx.user.id,
        actor_name: ctx.user.google_user_name,
        message: `Revoked invitation for ${invitation.email}`,
        organization_id: organizationId,
      });

      return successResult({
        updated: inviteId,
      });
    }),
});
