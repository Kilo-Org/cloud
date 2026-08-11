import { MAX_ORGANIZATION_GROUP_ASSIGNMENTS } from '@kilocode/db/schema-types';
import {
  OrganizationGroupMetadataSchema,
  OrganizationGroupPoliciesSchema,
  OrganizationGroupPolicySchema,
  OrganizationGroupPolicyTargetSchema,
  OrganizationGroupPolicyTypeSchema,
} from '@/lib/organizations/group-policies/organization-group-policies';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import {
  createOrganizationGroup,
  deleteOrganizationGroup,
  getOrganizationGroupPolicySettings,
  listOrganizationGroupsForManager,
  listOrganizationGroupsForMember,
  removeDefaultOrganizationGroupPolicy,
  removeOrganizationGroupPolicy,
  setDefaultOrganizationGroupPolicy,
  setOrganizationGroupMembers,
  setOrganizationGroupPolicy,
  setOrganizationMemberGroups,
  updateOrganizationGroupMetadata,
  updateOrganizationGroupDetails,
} from '@/lib/organizations/organization-groups';
import { createTRPCRouter } from '@/lib/trpc/init';
import {
  ensureOrganizationAccess,
  OrganizationIdInputSchema,
  organizationBillingProcedure,
  organizationMemberProcedure,
  organizationAdminMutationProcedure,
} from '@/routers/organizations/utils';
import { getModelAccessPolicyEditorData } from '@/lib/organizations/group-policies/model-access/model-access.server';

const GroupIdInputSchema = OrganizationIdInputSchema.extend({ groupId: z.uuid() }).strict();

const CreateGroupInputSchema = OrganizationIdInputSchema.extend({
  ...OrganizationGroupMetadataSchema.shape,
  policies: OrganizationGroupPoliciesSchema.optional().default([]),
}).strict();

const UpdateMetadataInputSchema = GroupIdInputSchema.extend({
  name: OrganizationGroupMetadataSchema.shape.name.optional(),
  description: OrganizationGroupMetadataSchema.shape.description,
})
  .strict()
  .refine(input => input.name !== undefined || input.description !== undefined, {
    message: 'Provide a name or description to update.',
  });

const SetPolicyInputSchema = GroupIdInputSchema.extend({
  policy: OrganizationGroupPolicySchema,
}).strict();

const UpdateGroupDetailsInputSchema = GroupIdInputSchema.extend({
  ...OrganizationGroupMetadataSchema.shape,
  userIds: z.array(z.string().min(1)).max(MAX_ORGANIZATION_GROUP_ASSIGNMENTS),
}).strict();

const RemovePolicyInputSchema = GroupIdInputSchema.extend({
  policyType: OrganizationGroupPolicyTypeSchema,
}).strict();

const SetMembersInputSchema = GroupIdInputSchema.extend({
  userIds: z.array(z.string().min(1)).max(MAX_ORGANIZATION_GROUP_ASSIGNMENTS),
}).strict();

const SetMemberGroupsInputSchema = OrganizationIdInputSchema.extend({
  userId: z.string().min(1),
  groupIds: z.array(z.uuid()).max(MAX_ORGANIZATION_GROUP_ASSIGNMENTS),
}).strict();

const SetDefaultPolicyInputSchema = OrganizationIdInputSchema.extend({
  policy: OrganizationGroupPolicySchema,
}).strict();

function actor(ctx: { user: { id: string; google_user_email: string; google_user_name: string } }) {
  return {
    id: ctx.user.id,
    email: ctx.user.google_user_email,
    name: ctx.user.google_user_name,
  };
}

export const organizationGroupsRouter = createTRPCRouter({
  list: organizationMemberProcedure
    .input(OrganizationIdInputSchema)
    .query(async ({ input, ctx }) => {
      const role = await ensureOrganizationAccess(ctx, input.organizationId);
      if (role === 'owner' || role === 'billing_manager') {
        return {
          access: 'manager' as const,
          groups: await listOrganizationGroupsForManager(input.organizationId),
          canEdit: role === 'owner',
        };
      }
      return {
        access: 'member' as const,
        groups: await listOrganizationGroupsForMember(input.organizationId, ctx.user.id),
        canEdit: false as const,
      };
    }),

  get: organizationBillingProcedure.input(GroupIdInputSchema).query(async ({ input }) => {
    const groups = await listOrganizationGroupsForManager(input.organizationId);
    const group = groups.find(candidate => candidate.id === input.groupId);
    if (!group) throw new TRPCError({ code: 'NOT_FOUND', message: 'Group not found' });
    return { group };
  }),

  create: organizationAdminMutationProcedure
    .input(CreateGroupInputSchema)
    .mutation(async ({ input, ctx }) => {
      return await createOrganizationGroup({
        organizationId: input.organizationId,
        actor: actor(ctx),
        name: input.name,
        description: input.description,
        policies: input.policies,
      });
    }),

  updateMetadata: organizationAdminMutationProcedure
    .input(UpdateMetadataInputSchema)
    .mutation(async ({ input, ctx }) => {
      return await updateOrganizationGroupMetadata({
        organizationId: input.organizationId,
        groupId: input.groupId,
        actor: actor(ctx),
        name: input.name,
        description: input.description,
      });
    }),

  updateDetails: organizationAdminMutationProcedure
    .input(UpdateGroupDetailsInputSchema)
    .mutation(async ({ input, ctx }) => {
      return await updateOrganizationGroupDetails({
        organizationId: input.organizationId,
        groupId: input.groupId,
        actor: actor(ctx),
        name: input.name,
        description: input.description,
        userIds: input.userIds,
      });
    }),

  setPolicy: organizationAdminMutationProcedure
    .input(SetPolicyInputSchema)
    .mutation(async ({ input, ctx }) => {
      return await setOrganizationGroupPolicy({
        organizationId: input.organizationId,
        groupId: input.groupId,
        actor: actor(ctx),
        policy: input.policy,
      });
    }),

  removePolicy: organizationAdminMutationProcedure
    .input(RemovePolicyInputSchema)
    .mutation(async ({ input, ctx }) => {
      return await removeOrganizationGroupPolicy({
        organizationId: input.organizationId,
        groupId: input.groupId,
        actor: actor(ctx),
        policyType: input.policyType,
      });
    }),

  setMembers: organizationAdminMutationProcedure
    .input(SetMembersInputSchema)
    .mutation(async ({ input, ctx }) => {
      return await setOrganizationGroupMembers({
        organizationId: input.organizationId,
        groupId: input.groupId,
        actor: actor(ctx),
        userIds: input.userIds,
      });
    }),

  setMemberGroups: organizationAdminMutationProcedure
    .input(SetMemberGroupsInputSchema)
    .mutation(async ({ input, ctx }) => {
      return await setOrganizationMemberGroups({
        organizationId: input.organizationId,
        userId: input.userId,
        actor: actor(ctx),
        groupIds: input.groupIds,
      });
    }),

  delete: organizationAdminMutationProcedure
    .input(GroupIdInputSchema)
    .mutation(async ({ input, ctx }) => {
      return await deleteOrganizationGroup({
        organizationId: input.organizationId,
        groupId: input.groupId,
        actor: actor(ctx),
      });
    }),

  getPolicySettings: organizationBillingProcedure
    .input(OrganizationIdInputSchema)
    .query(async ({ input }) => {
      return await getOrganizationGroupPolicySettings(input.organizationId);
    }),

  getPolicyEditorData: organizationBillingProcedure
    .input(
      OrganizationIdInputSchema.extend({
        policyType: OrganizationGroupPolicyTypeSchema,
        target: OrganizationGroupPolicyTargetSchema,
      }).strict()
    )
    .query(async ({ input }) => {
      switch (input.policyType) {
        case 'model_access':
          return await getModelAccessPolicyEditorData(input.organizationId, input.target);
      }
    }),

  setDefaultPolicy: organizationAdminMutationProcedure
    .input(SetDefaultPolicyInputSchema)
    .mutation(async ({ input, ctx }) => {
      return await setDefaultOrganizationGroupPolicy({
        organizationId: input.organizationId,
        actor: actor(ctx),
        policy: input.policy,
      });
    }),

  removeDefaultPolicy: organizationAdminMutationProcedure
    .input(
      OrganizationIdInputSchema.extend({ policyType: OrganizationGroupPolicyTypeSchema }).strict()
    )
    .mutation(async ({ input, ctx }) => {
      return await removeDefaultOrganizationGroupPolicy({
        organizationId: input.organizationId,
        actor: actor(ctx),
        policyType: input.policyType,
      });
    }),
});
