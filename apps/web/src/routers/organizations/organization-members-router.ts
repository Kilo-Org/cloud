import {
  updateUserRoleInOrganization,
  removeUserFromOrganization,
  addUserToOrganization,
  getOrganizationById,
  getOrganizationMembers,
  inviteUserToOrganization,
  getAcceptInviteUrl,
} from '@/lib/organizations/organizations';
import { updateOrganizationUserLimit } from '@/lib/organizations/organization-usage';
import {
  organization_memberships,
  organization_invitations,
  kilocode_users,
  organizations,
  external_side_effect_outbox,
} from '@kilocode/db/schema';
import { db, sql } from '@/lib/drizzle';
import { createTRPCRouter } from '@/lib/trpc/init';
import {
  ensureOrganizationAccess,
  OrganizationIdInputSchema,
  organizationAdminMutationProcedure,
  organizationBillingMutationProcedure,
  organizationMemberProcedure,
} from '@/routers/organizations/utils';
import { ORGANIZATION_MANAGE_ROLES } from '@kilocode/app-shared/organizations';
import {
  enqueueInviteEmail,
  resetInviteEmailForResend,
} from '@kilocode/db/external-side-effect-outbox';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import * as z from 'zod';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { findUserById } from '@/lib/user';
import { successResult } from '@/lib/maybe-result';
import { destroyOrgInstancesForUser } from '@/lib/kiloclaw/instance-registry';
import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { revokeGatewayStateForOrganizationMember } from '@/lib/mcp-gateway/lifecycle-service';
import { invalidateOrganizationSessionAccess } from '@/lib/session-ingest-client';
import {
  OrganizationRoleSchema,
  PublicOrganizationMembersSchema,
} from '@/lib/organizations/organization-types';
import type { OrganizationRole } from '@/lib/organizations/organization-types';

const MAX_DAILY_LIMIT_USD = 2000;

const UpdateMemberSchema = OrganizationIdInputSchema.extend({
  memberId: z.string(),
  role: OrganizationRoleSchema.optional(),
  dailyUsageLimitUsd: z.number().min(0).max(MAX_DAILY_LIMIT_USD).nullable().optional(),
});

const RemoveMemberSchema = OrganizationIdInputSchema.extend({
  memberId: z.string(),
});

const InviteMemberSchema = OrganizationIdInputSchema.extend({
  email: z.email('Invalid email address'),
  role: OrganizationRoleSchema,
});

const DeleteInviteSchema = OrganizationIdInputSchema.extend({
  inviteId: z.string(),
});

const ResendInviteSchema = OrganizationIdInputSchema.extend({
  inviteId: z.string(),
});

const SetChildMembershipsSchema = OrganizationIdInputSchema.extend({
  memberId: z.string(),
  childOrganizationIds: z.array(z.uuid()),
});

const OWNER_AUTHORITY_MESSAGE = 'Only an organization owner can manage owners';

/**
 * Reserves owner authority for owners. Admins match owners everywhere else, but
 * may not grant the owner role nor act on an existing owner's membership. Both
 * halves are required: allowing only one would let an admin strip every owner
 * while being unable to appoint a replacement, leaving the org with no owner.
 *
 * Kilo staff bypass this because `ensureOrganizationAccess` resolves them to
 * `owner`.
 */
function assertOwnerAuthority(
  actorRole: OrganizationRole,
  target: { currentRole?: OrganizationRole | null; nextRole?: OrganizationRole | null }
): void {
  if (actorRole === 'owner') {
    return;
  }
  if (target.currentRole === 'owner' || target.nextRole === 'owner') {
    throw new TRPCError({ code: 'FORBIDDEN', message: OWNER_AUTHORITY_MESSAGE });
  }
}

async function getDirectOrganizationRole(
  organizationId: string,
  userId: string
): Promise<OrganizationRole | null> {
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

/**
 * The target membership's role, or undefined when the user is not a member.
 * `UQ_organization_memberships_org_user` makes the row unique per
 * (organization, member).
 */
async function readOrgMemberRole(
  organizationId: string,
  memberId: string
): Promise<{ role: OrganizationRole } | undefined> {
  const [member] = await db
    .select({ role: organization_memberships.role })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(organization_memberships.kilo_user_id, memberId)
      )
    );
  return member;
}

/** The target membership plus the service-account flag used by the removal guard. */
async function readOrgMemberWithBotFlag(
  organizationId: string,
  memberId: string
): Promise<{ role: OrganizationRole; isBot: boolean } | undefined> {
  const [member] = await db
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
  return member;
}

/** KiloClaw instance cleanup after a member removal (existing behavior, extracted). */
async function cleanupRemovedMemberInstances(
  memberId: string,
  organizationId: string
): Promise<void> {
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
}

export const organizationsMembersRouter = createTRPCRouter({
  listPublic: organizationMemberProcedure
    .input(OrganizationIdInputSchema)
    .output(PublicOrganizationMembersSchema)
    .query(async ({ input }) => {
      return await getOrganizationMembers(input.organizationId);
    }),

  update: organizationAdminMutationProcedure
    .input(UpdateMemberSchema)
    .mutation(async ({ input, ctx }) => {
      const { user } = ctx;
      const { organizationId, memberId, role, dailyUsageLimitUsd } = input;

      // Prevent users from changing their own role.
      if (role !== undefined && user.id === memberId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You cannot change your own role',
        });
      }

      // Limit-only update.
      if (role === undefined) {
        if (dailyUsageLimitUsd !== undefined) {
          const targetMember = await readOrgMemberRole(organizationId, memberId);
          if (!targetMember) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'User is not a member of this organization',
            });
          }

          await updateOrganizationUserLimit(organizationId, memberId, dailyUsageLimitUsd);
        }
        return successResult({ updated: 'limit' });
      }

      const targetMember = await readOrgMemberRole(organizationId, memberId);
      if (!targetMember) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User is not a member of this organization',
        });
      }

      // Only an owner may grant the owner role or change an existing owner's
      // role; admins match owners everywhere else.
      const actorRole = await ensureOrganizationAccess(
        ctx,
        organizationId,
        ORGANIZATION_MANAGE_ROLES
      );
      assertOwnerAuthority(actorRole, { currentRole: targetMember.role, nextRole: role });

      const updatedUser = await findUserById(memberId);
      const updatedUserEmail = updatedUser?.google_user_email || 'unknown';

      await db.transaction(async tx => {
        const updateResult = await updateUserRoleInOrganization(organizationId, memberId, role, tx);
        if (!updateResult.success) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Failed to update user role',
          });
        }
        await createAuditLog({
          action: 'organization.member.change_role',
          actor_email: user.google_user_email,
          actor_id: user.id,
          actor_name: user.google_user_name,
          message: `Changed role for user ${updatedUserEmail} from ${targetMember.role} to ${role}`,
          organization_id: organizationId,
          tx,
        });
      });

      if (dailyUsageLimitUsd !== undefined) {
        await updateOrganizationUserLimit(organizationId, memberId, dailyUsageLimitUsd);
      }

      return successResult({ updated: 'role and limit' });
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

        const wasAdded = await db.transaction(async tx => {
          const addedNow = await addUserToOrganization(childOrganizationId, memberId, 'member', tx);
          if (!addedNow) return false;
          await createAuditLog({
            action: 'organization.member.admin_add',
            actor_email: user.google_user_email,
            actor_id: user.id,
            actor_name: user.google_user_name,
            message: `Added parent organization member ${parentMember.email} as a member from parent organization ${organizationId}`,
            organization_id: childOrganizationId,
            tx,
          });
          return true;
        });

        if (wasAdded) {
          added.push(childOrganizationId);
        }
      }

      for (const membership of existingMemberships) {
        if (selectedChildOrganizationIds.has(membership.organizationId)) continue;

        const wasRemoved = await db.transaction(async tx => {
          const result = await removeUserFromOrganization(
            membership.organizationId,
            memberId,
            user.id,
            tx
          );
          if ((result.rowCount ?? 0) === 0) return false;
          await revokeGatewayStateForOrganizationMember(tx, membership.organizationId, memberId);
          await createAuditLog({
            action: 'organization.member.remove',
            actor_email: user.google_user_email,
            actor_id: user.id,
            actor_name: user.google_user_name,
            message: `Removed parent organization member ${parentMember.email} from child organization via parent organization ${organizationId}`,
            organization_id: membership.organizationId,
            tx,
          });
          return true;
        });

        if (wasRemoved) {
          removed.push(membership.organizationId);
          // Best-effort session access invalidation after the transaction commits.
          try {
            await invalidateOrganizationSessionAccess(memberId, membership.organizationId);
          } catch {
            // A removed member loses cached access within the cache TTL even
            // when this call fails.
          }
        }
      }

      return successResult({ added, removed });
    }),
  remove: organizationAdminMutationProcedure
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

      const targetMember = await readOrgMemberWithBotFlag(organizationId, memberId);
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

      // Only an owner may act on an existing owner's membership; admins match
      // owners everywhere else.
      const actorRole = await ensureOrganizationAccess(
        ctx,
        organizationId,
        ORGANIZATION_MANAGE_ROLES
      );
      assertOwnerAuthority(actorRole, { currentRole: targetMember.role });

      const result = await removeUserFromOrganization(organizationId, memberId, user.id);
      if (result.rowCount === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Failed to remove user from organization',
        });
      }

      const removedUser = await findUserById(memberId);
      await createAuditLog({
        action: 'organization.member.remove',
        actor_email: user.google_user_email,
        actor_id: user.id,
        actor_name: user.google_user_name,
        message: `Removed user ${removedUser?.google_user_email || 'unknown'}`,
        organization_id: organizationId,
      });

      await revokeGatewayStateForOrganizationMember(db, organizationId, memberId);
      await cleanupRemovedMemberInstances(memberId, organizationId);

      return successResult({ updated: memberId });
    }),
  invite: organizationBillingMutationProcedure
    .input(InviteMemberSchema)
    .mutation(async ({ input, ctx }) => {
      const { user } = ctx;
      const { organizationId, email, role } = input;

      // Members can be invited by any billing-capable role; elevated roles
      // require organization-management authority, and only an owner may invite
      // another owner.
      if (role !== 'member') {
        const actorRole = await ensureOrganizationAccess(
          ctx,
          organizationId,
          ORGANIZATION_MANAGE_ROLES
        );
        assertOwnerAuthority(actorRole, { nextRole: role });
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
      try {
        const result = await db.transaction(async tx => {
          const invitation = await inviteUserToOrganization(
            organizationId,
            user.id,
            email,
            role,
            tx
          );
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

          return { acceptInviteUrl, invitationId: invitation.id };
        });

        return { ...result, emailStatus: 'pending' as const };
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
    }),
  deleteInvite: organizationAdminMutationProcedure
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

      // Owners can revoke any invitation; admins cannot revoke an owner invite,
      // which is a pending grant of owner authority.
      const actorRole = await ensureOrganizationAccess(
        ctx,
        organizationId,
        ORGANIZATION_MANAGE_ROLES
      );
      assertOwnerAuthority(actorRole, { currentRole: invitation.role });

      // Expire the invitation by setting expires_at to NOW, atomically with the audit.
      await db.transaction(async tx => {
        await tx
          .update(organization_invitations)
          .set({ expires_at: sql`NOW()` })
          .where(eq(organization_invitations.id, inviteId));

        // A revoked invitation must never produce a later invite email. Mark the
        // outbox row terminal so the cron drain skips it; the invitation row
        // stays expired.
        await tx
          .update(external_side_effect_outbox)
          .set({
            status: 'failed',
            claimed_at: null,
            next_attempt_at: null,
            last_error: 'revoked',
          })
          .where(eq(external_side_effect_outbox.invitation_id, inviteId));

        await createAuditLog({
          action: 'organization.user.revoke_invite',
          actor_email: ctx.user.google_user_email,
          actor_id: ctx.user.id,
          actor_name: ctx.user.google_user_name,
          message: `Revoked invitation for ${invitation.email}`,
          organization_id: organizationId,
          tx,
        });
      });

      return successResult({
        updated: inviteId,
      });
    }),
  resendInvite: organizationAdminMutationProcedure
    .input(ResendInviteSchema)
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

      // A revoked (expired) or already-accepted invitation must never be
      // resendable: resetting the outbox row would re-arm a terminal
      // invitation and let cron send mail for it. Refuse before touching the
      // outbox.
      if (new Date(invitation.expires_at).getTime() <= Date.now()) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'This invitation has expired',
        });
      }
      if (invitation.accepted_at != null) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'This invitation has already been accepted',
        });
      }

      // Owners can resend any invitation; admins cannot resend an owner invite,
      // which is a pending grant of owner authority.
      const actorRole = await ensureOrganizationAccess(
        ctx,
        organizationId,
        ORGANIZATION_MANAGE_ROLES
      );
      assertOwnerAuthority(actorRole, { currentRole: invitation.role });

      // Reset the existing outbox row rather than inserting a second one. The
      // reset fences on the invitation still being valid, so a concurrent
      // revoke (or a missing row) matches zero rows — refuse rather than
      // report a queued resend that never happened.
      const reset = await resetInviteEmailForResend(db, inviteId);
      if (reset === null) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'This invitation can no longer be resent',
        });
      }

      return successResult({
        updated: inviteId,
      });
    }),
});
