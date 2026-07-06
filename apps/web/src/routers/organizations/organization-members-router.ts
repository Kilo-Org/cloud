import {
  updateUserRoleInOrganization,
  removeUserFromOrganization,
  addUserToOrganization,
  getOrganizationById,
  inviteUserToOrganization,
  getAcceptInviteUrl,
} from '@/lib/organizations/organizations';
import { updateOrganizationUserLimit } from '@/lib/organizations/organization-usage';
import {
  organization_memberships,
  organization_invitations,
  kilocode_users,
  organizations,
} from '@kilocode/db/schema';
import { db, sql } from '@/lib/drizzle';
import { createTRPCRouter } from '@/lib/trpc/init';
import {
  ensureOrganizationAccess,
  OrganizationIdInputSchema,
  organizationBillingMutationProcedure,
  organizationOwnerMutationProcedure,
} from '@/routers/organizations/utils';
import { sendOrganizationInviteEmail } from '@/lib/email';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import * as z from 'zod';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { findUserById } from '@/lib/user';
import { successResult } from '@/lib/maybe-result';
import { destroyOrgInstancesForUser } from '@/lib/kiloclaw/instance-registry';
import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { revokeGatewayStateForOrganizationMember } from '@/lib/mcp-gateway/lifecycle-service';

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

const SetChildMembershipsSchema = OrganizationIdInputSchema.extend({
  memberId: z.string(),
  childOrganizationIds: z.array(z.uuid()),
});

async function getDirectOrganizationRole(
  organizationId: string,
  userId: string
): Promise<'owner' | 'member' | 'billing_manager' | null> {
  const [membership] = await db
    .select({ role: organization_memberships.role })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(organization_memberships.kilo_user_id, userId)
      )
    )
    .limit(1);

  return membership?.role ?? null;
}

export const organizationsMembersRouter = createTRPCRouter({
  update: organizationOwnerMutationProcedure
    .input(UpdateMemberSchema)
    .mutation(async ({ input, ctx }) => {
      const { user } = ctx;
      const { organizationId, memberId, role, dailyUsageLimitUsd } = input;

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
  setChildMemberships: organizationBillingMutationProcedure
    .input(SetChildMembershipsSchema)
    .mutation(async ({ input, ctx }) => {
      const { user } = ctx;
      const { organizationId, memberId } = input;
      const childOrganizationIds = Array.from(new Set(input.childOrganizationIds));

      const directRole = user.is_admin
        ? 'owner'
        : await getDirectOrganizationRole(organizationId, user.id);
      if (directRole !== 'owner' && directRole !== 'billing_manager') {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'You do not have the required organizational role to access this feature',
        });
      }

      const [parentMember] = await db
        .select({
          email: kilocode_users.google_user_email,
          isBot: kilocode_users.is_bot,
        })
        .from(organization_memberships)
        .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
        .where(
          and(
            eq(organization_memberships.organization_id, organizationId),
            eq(organization_memberships.kilo_user_id, memberId)
          )
        )
        .limit(1);

      if (!parentMember || parentMember.isBot) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User is not a member of the parent organization',
        });
      }

      const childOrganizations = await db
        .select({
          id: organizations.id,
        })
        .from(organizations)
        .where(
          and(
            eq(organizations.parent_organization_id, organizationId),
            isNull(organizations.deleted_at)
          )
        );
      const childOrganizationsById = new Map(childOrganizations.map(child => [child.id, child]));

      if (
        childOrganizationIds.some(
          childOrganizationId => !childOrganizationsById.has(childOrganizationId)
        )
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Selected organizations must be direct child organizations',
        });
      }

      const childIds = childOrganizations.map(child => child.id);
      const existingMemberships =
        childIds.length > 0
          ? await db
              .select({
                organizationId: organization_memberships.organization_id,
                role: organization_memberships.role,
              })
              .from(organization_memberships)
              .where(
                and(
                  eq(organization_memberships.kilo_user_id, memberId),
                  inArray(organization_memberships.organization_id, childIds)
                )
              )
          : [];
      const existingMembershipsByOrganizationId = new Map(
        existingMemberships.map(membership => [membership.organizationId, membership])
      );
      const selectedChildOrganizationIds = new Set(childOrganizationIds);

      const added: string[] = [];
      const removed: string[] = [];

      for (const childOrganizationId of childOrganizationIds) {
        if (existingMembershipsByOrganizationId.has(childOrganizationId)) continue;

        const wasAdded = await addUserToOrganization(childOrganizationId, memberId, 'member');
        if (wasAdded) {
          added.push(childOrganizationId);
          await createAuditLog({
            action: 'organization.member.admin_add',
            actor_email: user.google_user_email,
            actor_id: user.id,
            actor_name: user.google_user_name,
            message: `Added parent organization member ${parentMember.email} as a member from parent organization ${organizationId}`,
            organization_id: childOrganizationId,
          });
        }
      }

      for (const membership of existingMemberships) {
        if (selectedChildOrganizationIds.has(membership.organizationId)) continue;

        const result = await removeUserFromOrganization(
          membership.organizationId,
          memberId,
          user.id
        );
        if ((result.rowCount ?? 0) > 0) {
          removed.push(membership.organizationId);
          await revokeGatewayStateForOrganizationMember(db, membership.organizationId, memberId);
          await createAuditLog({
            action: 'organization.member.remove',
            actor_email: user.google_user_email,
            actor_id: user.id,
            actor_name: user.google_user_name,
            message: `Removed parent organization member ${parentMember.email} from child organization via parent organization ${organizationId}`,
            organization_id: membership.organizationId,
          });
        }
      }

      return successResult({ added, removed });
    }),
  remove: organizationOwnerMutationProcedure
    .input(RemoveMemberSchema)
    .mutation(async ({ input, ctx }) => {
      const { user } = ctx;
      const { organizationId, memberId } = input;

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

      const result = await removeUserFromOrganization(organizationId, memberId, user.id);
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

      await revokeGatewayStateForOrganizationMember(db, organizationId, memberId);

      // KiloClaw cleanup: destroy org instances assigned to the removed member.

      // Runs after the membership deletion transaction commits.
      // Fire-and-forget worker calls — Postgres rows are already soft-deleted,
      // so even if worker calls fail the instance is "dead" from the platform
      // perspective and reconciliation will clean up.
      try {
        const destroyedInstances = await destroyOrgInstancesForUser(memberId, organizationId);
        if (destroyedInstances.length > 0) {
          const client = new KiloClawInternalClient();
          const results = await Promise.allSettled(
            destroyedInstances.map(({ instanceId }) =>
              client.destroy(memberId, instanceId, { reason: 'org_member_cleanup' })
            )
          );
          for (const [i, result] of results.entries()) {
            if (result.status === 'rejected') {
              console.error(
                `[kiloclaw-org] Failed to destroy worker instance ${destroyedInstances[i].instanceId} for removed member ${memberId}:`,
                result.reason
              );
            }
          }
          console.log(
            `[kiloclaw-org] Destroyed ${destroyedInstances.length} instance(s) for removed member ${memberId} in org ${organizationId}`
          );
        }
      } catch (err) {
        console.error(
          `[kiloclaw-org] Failed to clean up KiloClaw instances for removed member ${memberId}:`,
          err
        );
      }

      return successResult({ updated: memberId });
    }),
  invite: organizationBillingMutationProcedure
    .input(InviteMemberSchema)
    .mutation(async ({ input, ctx }) => {
      const { user } = ctx;
      const { organizationId, email, role } = input;

      if (role !== 'member') {
        await ensureOrganizationAccess(ctx, organizationId, ['owner']);
      }

      // Get organization details
      const organization = await getOrganizationById(organizationId);
      if (!organization) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      // Owners and Kilo admins can invite any role. Billing managers can invite members only.
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
  deleteInvite: organizationOwnerMutationProcedure
    .input(DeleteInviteSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId, inviteId } = input;

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
