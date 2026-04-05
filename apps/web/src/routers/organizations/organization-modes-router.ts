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
import { OrganizationModeConfigSchema } from '@/lib/organizations/organization-types';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { getOrganizationById } from '@/lib/organizations/organizations';
import { successResult } from '@/lib/maybe-result';

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
  config: OrganizationModeConfigSchema.partial().optional(),
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
  config: OrganizationModeConfigSchema.partial().optional(),
});

const DeleteModeInputSchema = OrganizationIdInputSchema.extend({
  modeId: z.uuid(),
});

const ModeIdInputSchema = OrganizationIdInputSchema.extend({
  modeId: z.uuid(),
});

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

      const mode = await createOrganizationMode(organizationId, ctx.user.id, name, slug, config);

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

      const mode = await updateOrganizationMode(modeId, updates);

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
        const configChanges: string[] = [];

        if (updates.config.roleDefinition !== existingMode.config.roleDefinition) {
          const oldValue = existingMode.config.roleDefinition || '(empty)';
          const newValue = updates.config.roleDefinition || '(empty)';
          configChanges.push(
            `roleDefinition: "${oldValue.substring(0, 50)}${oldValue.length > 50 ? '...' : ''}" → "${newValue.substring(0, 50)}${newValue.length > 50 ? '...' : ''}"`
          );
        }
        if (updates.config.whenToUse !== existingMode.config.whenToUse) {
          const oldValue = existingMode.config.whenToUse || '(empty)';
          const newValue = updates.config.whenToUse || '(empty)';
          configChanges.push(
            `whenToUse: "${oldValue.substring(0, 50)}${oldValue.length > 50 ? '...' : ''}" → "${newValue.substring(0, 50)}${newValue.length > 50 ? '...' : ''}"`
          );
        }
        if (updates.config.description !== existingMode.config.description) {
          const oldValue = existingMode.config.description || '(empty)';
          const newValue = updates.config.description || '(empty)';
          configChanges.push(
            `description: "${oldValue.substring(0, 50)}${oldValue.length > 50 ? '...' : ''}" → "${newValue.substring(0, 50)}${newValue.length > 50 ? '...' : ''}"`
          );
        }
        if (updates.config.customInstructions !== existingMode.config.customInstructions) {
          const oldValue = existingMode.config.customInstructions || '(empty)';
          const newValue = updates.config.customInstructions || '(empty)';
          configChanges.push(
            `customInstructions: "${oldValue.substring(0, 50)}${oldValue.length > 50 ? '...' : ''}" → "${newValue.substring(0, 50)}${newValue.length > 50 ? '...' : ''}"`
          );
        }
        if (
          updates.config.groups !== undefined &&
          existingMode.config.groups !== undefined &&
          JSON.stringify(updates.config.groups) !== JSON.stringify(existingMode.config.groups)
        ) {
          const oldValue = JSON.stringify(existingMode.config.groups);
          const newValue = JSON.stringify(updates.config.groups);
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
