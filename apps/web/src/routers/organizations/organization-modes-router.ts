import { createTRPCRouter } from '@/lib/trpc/init';
import {
  OrganizationIdInputSchema,
  organizationMemberProcedure,
  organizationMemberMutationProcedure,
} from '@/routers/organizations/utils';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import {
  createOrganizationMode,
  getAllOrganizationModes,
  getOrganizationModeById,
  updateOrganizationMode,
  deleteOrganizationMode,
} from '@/lib/organizations/organization-modes';
import {
  OrganizationModeConfigSchema,
  type OrganizationModeConfig,
} from '@/lib/organizations/organization-types';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { getOrganizationById } from '@/lib/organizations/organizations';
import { successResult } from '@/lib/maybe-result';
import { createAllowPredicateFromRestrictions } from '@/lib/model-allow.server';
import { getEffectiveModelRestrictions } from '@/lib/organizations/model-restrictions';
import { normalizeModelId } from '@/lib/ai-gateway/model-utils';
import { isReleaseToggleEnabled } from '@/lib/posthog-feature-flags';

const ORGANIZATION_MODE_DEFAULT_MODEL_FLAG = 'org-default-model-config';

const ModeConfigInputSchema = OrganizationModeConfigSchema.partial();

const ModeUpdateConfigInputSchema = ModeConfigInputSchema.extend({
  defaultModel: z.string().min(1, 'Default model cannot be empty').nullable().optional(),
});

type ModeUpdateConfigInput = z.infer<typeof ModeUpdateConfigInputSchema>;
type DefaultModelConfig = {
  defaultModel?: string | null;
};

const CreateModeInputSchema = OrganizationIdInputSchema.extend({
  name: z
    .string()
    .min(1, 'Mode name is required')
    .max(100, 'Mode name must be less than 100 characters'),
  slug: z
    .string()
    .min(1, 'Mode slug is required')
    .max(50, 'Mode slug must be less than 50 characters')
    .regex(/^[a-z0-9-]+$/, 'Mode slug must contain only lowercase letters, numbers, and hyphens'),
  config: ModeConfigInputSchema.optional(),
});

const UpdateModeInputSchema = OrganizationIdInputSchema.extend({
  modeId: z.uuid(),
  name: z.string().min(1).max(100).optional(),
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  config: ModeUpdateConfigInputSchema.optional(),
});

const DeleteModeInputSchema = OrganizationIdInputSchema.extend({
  modeId: z.uuid(),
});

const ModeIdInputSchema = OrganizationIdInputSchema.extend({
  modeId: z.uuid(),
});

type DefaultModelChange =
  | { kind: 'none' }
  | { kind: 'clear' }
  | { kind: 'set'; defaultModel: string };

function getDefaultModelChange(config: DefaultModelConfig | undefined): DefaultModelChange {
  if (!config || !Object.prototype.hasOwnProperty.call(config, 'defaultModel')) {
    return { kind: 'none' };
  }

  if (config.defaultModel === null) {
    return { kind: 'clear' };
  }

  if (typeof config.defaultModel === 'string') {
    return { kind: 'set', defaultModel: config.defaultModel };
  }

  return { kind: 'none' };
}

function assertDefaultModelCanBeSet(
  organization: NonNullable<Awaited<ReturnType<typeof getOrganizationById>>>,
  change: DefaultModelChange
): void {
  if (change.kind !== 'set') {
    return;
  }

  if (organization.plan !== 'enterprise') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Model access configuration is not available for this organization.',
    });
  }
}

async function assertDefaultModelConfigEnabled(
  userId: string,
  change: DefaultModelChange
): Promise<void> {
  if (change.kind === 'none') {
    return;
  }

  if (
    process.env.NODE_ENV !== 'development' &&
    !(await isReleaseToggleEnabled(ORGANIZATION_MODE_DEFAULT_MODEL_FLAG, userId))
  ) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Mode default model configuration is not available',
    });
  }
}

function normalizeModeConfig(
  config: ModeUpdateConfigInput | undefined
): Partial<OrganizationModeConfig> | undefined {
  if (!config) {
    return undefined;
  }

  const { defaultModel, ...rest } = config;
  if (defaultModel === null) {
    return { ...rest, defaultModel: undefined };
  }
  if (defaultModel === undefined) {
    return rest;
  }

  return { ...rest, defaultModel };
}

async function validateDefaultModel(
  organization: NonNullable<Awaited<ReturnType<typeof getOrganizationById>>>,
  defaultModel: string
): Promise<void> {
  const normalizedDefaultModel = normalizeModelId(defaultModel);
  if (normalizedDefaultModel.endsWith('/*')) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Default model '${defaultModel}' is not a concrete model identifier`,
    });
  }

  const isAllowed = createAllowPredicateFromRestrictions(
    getEffectiveModelRestrictions(organization)
  );

  if (!(await isAllowed(normalizedDefaultModel))) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Default model '${defaultModel}' is not in the organization's allowed models list`,
    });
  }
}

export const organizationModesRouter = createTRPCRouter({
  create: organizationMemberMutationProcedure
    .input(CreateModeInputSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId, name, slug, config } = input;

      const organization = await getOrganizationById(organizationId);
      if (!organization) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      const defaultModelChange = getDefaultModelChange(config);
      assertDefaultModelCanBeSet(organization, defaultModelChange);
      await assertDefaultModelConfigEnabled(ctx.user.id, defaultModelChange);
      if (defaultModelChange.kind === 'set') {
        await validateDefaultModel(organization, defaultModelChange.defaultModel);
      }

      const mode = await createOrganizationMode(
        organizationId,
        ctx.user.id,
        name,
        slug,
        normalizeModeConfig(config)
      );

      if (!mode) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `A mode with slug "${slug}" already exists in this organization`,
        });
      }

      await createAuditLog({
        action: 'organization.mode.create',
        actor_email: ctx.user.google_user_email,
        actor_id: ctx.user.id,
        actor_name: ctx.user.google_user_name,
        message: `Created mode "${name}" with slug "${slug}": ${JSON.stringify(config)}`,
        organization_id: organizationId,
      });

      return { mode };
    }),

  list: organizationMemberProcedure.input(OrganizationIdInputSchema).query(async ({ input }) => {
    const { organizationId } = input;

    const modes = await getAllOrganizationModes(organizationId);

    return { modes };
  }),

  getById: organizationMemberProcedure.input(ModeIdInputSchema).query(async ({ input }) => {
    const { modeId, organizationId } = input;

    const mode = await getOrganizationModeById(organizationId, modeId);

    if (!mode) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Mode not found',
      });
    }

    return { mode };
  }),

  update: organizationMemberMutationProcedure
    .input(UpdateModeInputSchema)
    .mutation(async ({ input, ctx }) => {
      const { modeId, organizationId, ...updates } = input;

      const existingMode = await getOrganizationModeById(organizationId, modeId);

      if (!existingMode) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Mode not found',
        });
      }

      const organization = await getOrganizationById(organizationId);
      if (!organization) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      const defaultModelChange = getDefaultModelChange(updates.config);
      assertDefaultModelCanBeSet(organization, defaultModelChange);
      await assertDefaultModelConfigEnabled(ctx.user.id, defaultModelChange);
      if (defaultModelChange.kind === 'set') {
        await validateDefaultModel(organization, defaultModelChange.defaultModel);
      }
      const normalizedConfig = normalizeModeConfig(updates.config);

      const mode = await updateOrganizationMode(organizationId, modeId, {
        ...updates,
        config: normalizedConfig,
      });

      if (!mode) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `A mode with slug "${updates.slug}" already exists in this organization`,
        });
      }

      const changes: string[] = [];
      if (updates.name && updates.name !== existingMode.name) {
        changes.push(`name: "${existingMode.name}" → "${updates.name}"`);
      }
      if (updates.slug && updates.slug !== existingMode.slug) {
        changes.push(`slug: "${existingMode.slug}" → "${updates.slug}"`);
      }
      if (updates.config) {
        const auditConfig = normalizedConfig ?? updates.config;
        const configChanges: string[] = [];

        if (
          'roleDefinition' in auditConfig &&
          auditConfig.roleDefinition !== existingMode.config.roleDefinition
        ) {
          const oldValue = existingMode.config.roleDefinition || '(empty)';
          const newValue = auditConfig.roleDefinition || '(empty)';
          configChanges.push(
            `roleDefinition: "${oldValue.substring(0, 50)}${oldValue.length > 50 ? '...' : ''}" → "${newValue.substring(0, 50)}${newValue.length > 50 ? '...' : ''}"`
          );
        }
        if ('whenToUse' in auditConfig && auditConfig.whenToUse !== existingMode.config.whenToUse) {
          const oldValue = existingMode.config.whenToUse || '(empty)';
          const newValue = auditConfig.whenToUse || '(empty)';
          configChanges.push(
            `whenToUse: "${oldValue.substring(0, 50)}${oldValue.length > 50 ? '...' : ''}" → "${newValue.substring(0, 50)}${newValue.length > 50 ? '...' : ''}"`
          );
        }
        if (
          'description' in auditConfig &&
          auditConfig.description !== existingMode.config.description
        ) {
          const oldValue = existingMode.config.description || '(empty)';
          const newValue = auditConfig.description || '(empty)';
          configChanges.push(
            `description: "${oldValue.substring(0, 50)}${oldValue.length > 50 ? '...' : ''}" → "${newValue.substring(0, 50)}${newValue.length > 50 ? '...' : ''}"`
          );
        }
        if (
          'customInstructions' in auditConfig &&
          auditConfig.customInstructions !== existingMode.config.customInstructions
        ) {
          const oldValue = existingMode.config.customInstructions || '(empty)';
          const newValue = auditConfig.customInstructions || '(empty)';
          configChanges.push(
            `customInstructions: "${oldValue.substring(0, 50)}${oldValue.length > 50 ? '...' : ''}" → "${newValue.substring(0, 50)}${newValue.length > 50 ? '...' : ''}"`
          );
        }
        if (
          'defaultModel' in auditConfig &&
          auditConfig.defaultModel !== existingMode.config.defaultModel
        ) {
          if (existingMode.config.defaultModel && auditConfig.defaultModel) {
            configChanges.push(
              `defaultModel: "${existingMode.config.defaultModel}" → "${auditConfig.defaultModel}"`
            );
          } else if (auditConfig.defaultModel) {
            configChanges.push(`defaultModel: set to "${auditConfig.defaultModel}"`);
          } else if (existingMode.config.defaultModel) {
            configChanges.push(`defaultModel: cleared "${existingMode.config.defaultModel}"`);
          }
        }
        if (
          auditConfig.groups !== undefined &&
          existingMode.config.groups !== undefined &&
          JSON.stringify(auditConfig.groups) !== JSON.stringify(existingMode.config.groups)
        ) {
          const oldValue = JSON.stringify(existingMode.config.groups);
          const newValue = JSON.stringify(auditConfig.groups);
          configChanges.push(
            `groups: ${oldValue.substring(0, 50)}${oldValue.length > 50 ? '...' : ''} → ${newValue.substring(0, 50)}${newValue.length > 50 ? '...' : ''}`
          );
        }

        if (configChanges.length > 0) {
          changes.push(...configChanges);
        } else {
          changes.push('config updated (no property changes detected)');
        }
      }

      await createAuditLog({
        action: 'organization.mode.update',
        actor_email: ctx.user.google_user_email,
        actor_id: ctx.user.id,
        actor_name: ctx.user.google_user_name,
        message: `Updated mode "${existingMode.name}"${changes.length > 0 ? `: ${changes.join(', ')}` : ''}`,
        organization_id: existingMode.organization_id,
      });

      return { mode };
    }),

  delete: organizationMemberMutationProcedure
    .input(DeleteModeInputSchema)
    .mutation(async ({ input, ctx }) => {
      const { modeId, organizationId } = input;

      const mode = await getOrganizationModeById(organizationId, modeId);

      if (!mode) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Mode not found',
        });
      }

      await deleteOrganizationMode(modeId);

      await createAuditLog({
        action: 'organization.mode.delete',
        actor_email: ctx.user.google_user_email,
        actor_id: ctx.user.id,
        actor_name: ctx.user.google_user_name,
        message: `Deleted mode "${mode.name}" (slug: "${mode.slug}")`,
        organization_id: mode.organization_id,
      });

      return successResult();
    }),
});
