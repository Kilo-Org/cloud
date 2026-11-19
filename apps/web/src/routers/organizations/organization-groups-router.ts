import {
  canManageOrganization,
  canManageOrganizationBilling,
} from '@kilocode/app-shared/organizations';
import { MAX_ORGANIZATION_GROUP_ASSIGNMENTS } from '@kilocode/db/schema-types';
import {
  MAX_ORGANIZATION_GROUP_POLICIES,
  ORGANIZATION_GROUP_MODEL_ACCESS_POLICY_TYPE,
  OrganizationGroupMetadataSchema,
  OrganizationGroupModelAccessPolicySchema,
  type OrganizationGroupPolicies,
  type OrganizationGroupModelAccessPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/organization-group-policies';
import {
  OrganizationPermissionPolicySchema,
  OrganizationPermissionPolicyTypeSchema,
} from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/permission-policy.schema';
import {
  getOrganizationPermissionPolicy,
  getStoredOrganizationPermissionPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/permission-policy.server';
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
} from '@kilocode/web-shared/lib/organizations/organization-groups';
import { createTRPCRouter, type TRPCContext } from '@kilocode/web-shared/lib/trpc/init';
import {
  ensureOrganizationAccess,
  OrganizationIdInputSchema,
  organizationBillingProcedure,
  organizationMemberProcedure,
  organizationAdminMutationProcedure,
} from '@kilocode/web-shared/routers/organizations/utils';
import { getModelAccessPolicyEditorData } from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';

const GroupIdInputSchema = OrganizationIdInputSchema.extend({ groupId: z.uuid() }).strict();

const ModelPolicyTypeSchema = z.enum([ORGANIZATION_GROUP_MODEL_ACCESS_POLICY_TYPE]);
const ModelPolicySchema = z.discriminatedUnion('type', [OrganizationGroupModelAccessPolicySchema]);

const CreateGroupInputSchema = OrganizationIdInputSchema.extend({
  ...OrganizationGroupMetadataSchema.shape,
  policies: z
    .array(ModelPolicySchema)
    .max(MAX_ORGANIZATION_GROUP_POLICIES)
    .refine(policies => policies.length < 2, {
      message: 'Duplicate organization group policy type: model_access',
      path: [1, 'type'],
    })
    .optional()
    .default([]),
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
  policy: ModelPolicySchema,
}).strict();

const UpdateGroupDetailsInputSchema = GroupIdInputSchema.extend({
  ...OrganizationGroupMetadataSchema.shape,
  userIds: z.array(z.string().min(1)).max(MAX_ORGANIZATION_GROUP_ASSIGNMENTS),
}).strict();

const RemovePolicyInputSchema = GroupIdInputSchema.extend({
  policyType: ModelPolicyTypeSchema,
}).strict();

const SetMembersInputSchema = GroupIdInputSchema.extend({
  userIds: z.array(z.string().min(1)).max(MAX_ORGANIZATION_GROUP_ASSIGNMENTS),
}).strict();

const SetMemberGroupsInputSchema = OrganizationIdInputSchema.extend({
  userId: z.string().min(1),
  groupIds: z.array(z.uuid()).max(MAX_ORGANIZATION_GROUP_ASSIGNMENTS),
}).strict();

const SetDefaultPolicyInputSchema = OrganizationIdInputSchema.extend({
  policy: ModelPolicySchema,
}).strict();

const PermissionPolicyTargetSchema = OrganizationIdInputSchema.extend({
  groupId: z.uuid().optional(),
});

function modelPolicies(policies: OrganizationGroupPolicies): OrganizationGroupModelAccessPolicy[] {
  return policies.filter(policy => policy.type === 'model_access');
}

function modelOnlyGroup<Group extends { policies: OrganizationGroupPolicies }>({
  policies,
  ...group
}: Group) {
  return { ...group, policies: modelPolicies(policies) };
}

// MCP can forward a personal bearer, so human_bearer is not a browser session.
function isPermissionPolicyAdminSession(ctx: TRPCContext) {
  return (
    ctx.credential === 'session' &&
    !ctx.authViaToken &&
    !ctx.headersList?.has('authorization') &&
    !ctx.cloudAgentAuthority &&
    !ctx.internalApiUse &&
    !ctx.tokenSource
  );
}

function assertPermissionPolicyAdminSession(ctx: TRPCContext) {
  if (!isPermissionPolicyAdminSession(ctx)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Use a browser session to administer organization permission policy.',
    });
  }
}

function actor(ctx: { user: { id: string; google_user_email: string; google_user_name: string } }) {
  return {
    id: ctx.user.id,
    email: ctx.user.google_user_email,
    name: ctx.user.google_user_name,
  };
}

export const organizationGroupsRouter = createTRPCRouter({
  adminPermissionPolicy: createTRPCRouter({
    settings: organizationBillingProcedure
      .input(PermissionPolicyTargetSchema.strict())
      .query(async ({ input, ctx }) => {
        assertPermissionPolicyAdminSession(ctx);
        return await getStoredOrganizationPermissionPolicy(input.organizationId, input.groupId);
      }),

    set: organizationAdminMutationProcedure
      .input(
        PermissionPolicyTargetSchema.extend({ policy: OrganizationPermissionPolicySchema }).strict()
      )
      .mutation(async ({ input, ctx }) => {
        assertPermissionPolicyAdminSession(ctx);
        const params = { ...input, actor: actor(ctx) };
        const { result, policyRevision } = input.groupId
          ? await setOrganizationGroupPolicy({ ...params, groupId: input.groupId })
          : await setDefaultOrganizationGroupPolicy(params);
        return { result: result.filter(policy => policy.type !== 'model_access'), policyRevision };
      }),

    remove: organizationAdminMutationProcedure
      .input(
        PermissionPolicyTargetSchema.extend({
          policyType: OrganizationPermissionPolicyTypeSchema,
        }).strict()
      )
      .mutation(async ({ input, ctx }) => {
        assertPermissionPolicyAdminSession(ctx);
        const params = { ...input, actor: actor(ctx) };
        const { result, policyRevision } = input.groupId
          ? await removeOrganizationGroupPolicy({ ...params, groupId: input.groupId })
          : await removeDefaultOrganizationGroupPolicy(params);
        return { result: result.filter(policy => policy.type !== 'model_access'), policyRevision };
      }),

    diagnostics: organizationBillingProcedure
      .input(OrganizationIdInputSchema.extend({ userId: z.string().min(1) }).strict())
      .query(async ({ input, ctx }) => {
        assertPermissionPolicyAdminSession(ctx);
        return await getOrganizationPermissionPolicy(input.organizationId, input.userId);
      }),
  }),

  list: organizationMemberProcedure
    .input(OrganizationIdInputSchema)
    .query(async ({ input, ctx }) => {
      const role = await ensureOrganizationAccess(ctx, input.organizationId);
      // The manager shape follows the roles the group writes admit: an admin
      // creates, updates and deletes a group like an owner, so it must also see
      // and open the groups it may change. A billing manager reads the same
      // shape without `canEdit`, which matches `organizationAdminMutationProcedure`.
      if (canManageOrganizationBilling(role)) {
        return {
          access: 'manager' as const,
          groups: (await listOrganizationGroupsForManager(input.organizationId)).map(
            modelOnlyGroup
          ),
          canEdit: canManageOrganization(role),
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
    return { group: modelOnlyGroup(group) };
  }),

  create: organizationAdminMutationProcedure
    .input(CreateGroupInputSchema)
    .mutation(async ({ input, ctx }) => {
      const { result, policyRevision } = await createOrganizationGroup({
        organizationId: input.organizationId,
        actor: actor(ctx),
        name: input.name,
        description: input.description,
        policies: input.policies,
      });
      return { result: modelOnlyGroup(result), policyRevision };
    }),

  updateMetadata: organizationAdminMutationProcedure
    .input(UpdateMetadataInputSchema)
    .mutation(async ({ input, ctx }) => {
      const { result, policyRevision } = await updateOrganizationGroupMetadata({
        organizationId: input.organizationId,
        groupId: input.groupId,
        actor: actor(ctx),
        name: input.name,
        description: input.description,
      });
      return { result: modelOnlyGroup(result), policyRevision };
    }),

  updateDetails: organizationAdminMutationProcedure
    .input(UpdateGroupDetailsInputSchema)
    .mutation(async ({ input, ctx }) => {
      const { result, policyRevision } = await updateOrganizationGroupDetails({
        organizationId: input.organizationId,
        groupId: input.groupId,
        actor: actor(ctx),
        name: input.name,
        description: input.description,
        userIds: input.userIds,
        permissionPolicyAdmin: isPermissionPolicyAdminSession(ctx),
      });
      return { result: modelOnlyGroup(result), policyRevision };
    }),

  setPolicy: organizationAdminMutationProcedure
    .input(SetPolicyInputSchema)
    .mutation(async ({ input, ctx }) => {
      const { result, policyRevision } = await setOrganizationGroupPolicy({
        organizationId: input.organizationId,
        groupId: input.groupId,
        actor: actor(ctx),
        policy: input.policy,
      });
      return { result: modelPolicies(result), policyRevision };
    }),

  removePolicy: organizationAdminMutationProcedure
    .input(RemovePolicyInputSchema)
    .mutation(async ({ input, ctx }) => {
      const { result, policyRevision } = await removeOrganizationGroupPolicy({
        organizationId: input.organizationId,
        groupId: input.groupId,
        actor: actor(ctx),
        policyType: input.policyType,
      });
      return { result: modelPolicies(result), policyRevision };
    }),

  setMembers: organizationAdminMutationProcedure
    .input(SetMembersInputSchema)
    .mutation(async ({ input, ctx }) => {
      return await setOrganizationGroupMembers({
        organizationId: input.organizationId,
        groupId: input.groupId,
        actor: actor(ctx),
        userIds: input.userIds,
        permissionPolicyAdmin: isPermissionPolicyAdminSession(ctx),
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
        permissionPolicyAdmin: isPermissionPolicyAdminSession(ctx),
      });
    }),

  delete: organizationAdminMutationProcedure
    .input(GroupIdInputSchema)
    .mutation(async ({ input, ctx }) => {
      return await deleteOrganizationGroup({
        organizationId: input.organizationId,
        groupId: input.groupId,
        actor: actor(ctx),
        permissionPolicyAdmin: isPermissionPolicyAdminSession(ctx),
      });
    }),

  getPolicySettings: organizationBillingProcedure
    .input(OrganizationIdInputSchema)
    .query(async ({ input }) => {
      const settings = await getOrganizationGroupPolicySettings(input.organizationId);
      return { ...settings, defaultPolicies: modelPolicies(settings.defaultPolicies) };
    }),

  getPolicyEditorData: organizationBillingProcedure
    .input(OrganizationIdInputSchema.extend({ policyType: ModelPolicyTypeSchema }).strict())
    .query(async ({ input }) => getModelAccessPolicyEditorData(input.organizationId)),

  setDefaultPolicy: organizationAdminMutationProcedure
    .input(SetDefaultPolicyInputSchema)
    .mutation(async ({ input, ctx }) => {
      const { result, policyRevision } = await setDefaultOrganizationGroupPolicy({
        organizationId: input.organizationId,
        actor: actor(ctx),
        policy: input.policy,
      });
      return { result: modelPolicies(result), policyRevision };
    }),

  removeDefaultPolicy: organizationAdminMutationProcedure
    .input(OrganizationIdInputSchema.extend({ policyType: ModelPolicyTypeSchema }).strict())
    .mutation(async ({ input, ctx }) => {
      const { result, policyRevision } = await removeDefaultOrganizationGroupPolicy({
        organizationId: input.organizationId,
        actor: actor(ctx),
        policyType: input.policyType,
      });
      return { result: modelPolicies(result), policyRevision };
    }),
});
