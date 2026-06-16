import { createTRPCRouter } from '@/lib/trpc/init';
import {
  ensureOrganizationAccess,
  OrganizationIdInputSchema,
  organizationMemberProcedure,
  organizationMemberMutationProcedure,
} from '@/routers/organizations/utils';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import {
  createOrganizationMode,
  deleteOrganizationMode,
  getAllOrganizationModes,
  getOrganizationModeById,
  type OrganizationMode,
  updateOrganizationMode,
} from '@/lib/organizations/organization-modes';
import {
  OrganizationModeConfigSchema,
  type OrganizationModeConfig,
  type OrganizationSettings,
} from '@/lib/organizations/organization-types';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { getOrganizationById, mutateOrganizationSettings } from '@/lib/organizations/organizations';
import { successResult } from '@/lib/maybe-result';
import { isReleaseToggleEnabled } from '@/lib/posthog-feature-flags';
import { db } from '@/lib/drizzle';
import {
  DEFAULT_ORGANIZATION_AUTO_MODEL_SETTINGS,
  ORGANIZATION_AUTO_MODEL_FLAG,
} from '@/lib/organizations/organization-auto-model';

const ModeConfigInputSchema = OrganizationModeConfigSchema.partial();

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
  config: ModeConfigInputSchema.optional(),
});

const DeleteModeInputSchema = OrganizationIdInputSchema.extend({
  modeId: z.uuid(),
});

const ModeIdInputSchema = OrganizationIdInputSchema.extend({
  modeId: z.uuid(),
});

function hasRoute(routes: Record<string, string>, slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(routes, slug);
}

async function assertOrganizationAutoWriteEnabled(userId: string): Promise<void> {
  if (
    process.env.NODE_ENV !== 'development' &&
    !(await isReleaseToggleEnabled(ORGANIZATION_AUTO_MODEL_FLAG, userId))
  ) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Organization Auto routing configuration is not available',
    });
  }
}

function getOrganizationAutoSettings(
  settings: OrganizationSettings
): typeof DEFAULT_ORGANIZATION_AUTO_MODEL_SETTINGS {
  return settings.org_auto_model ?? DEFAULT_ORGANIZATION_AUTO_MODEL_SETTINGS;
}

function createModeUpdateAuditMessage(
  existingMode: OrganizationMode,
  updates: { name?: string; slug?: string; config?: Partial<OrganizationModeConfig> }
): string {
  const changes: string[] = [];
  if (updates.name && updates.name !== existingMode.name) {
    changes.push(`name: "${existingMode.name}" → "${updates.name}"`);
  }
  if (updates.slug && updates.slug !== existingMode.slug) {
    changes.push(`slug: "${existingMode.slug}" → "${updates.slug}"`);
  }
  if (updates.config) {
    const auditConfig = updates.config;
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

  return `Updated mode "${existingMode.name}"${changes.length > 0 ? `: ${changes.join(', ')}` : ''}`;
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

      let createdMode: OrganizationMode | null | undefined;
      await db.transaction(async tx => {
        await mutateOrganizationSettings(
          organizationId,
          async lockedOrganization => {
            createdMode = await createOrganizationMode(
              organizationId,
              ctx.user.id,
              name,
              slug,
              config,
              tx
            );

            if (!createdMode) {
              throw new TRPCError({
                code: 'CONFLICT',
                message: `A mode with slug "${slug}" already exists in this organization`,
              });
            }

            return lockedOrganization.settings;
          },
          tx
        );

        if (!createdMode) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Mode creation failed' });
        }

        await createAuditLog({
          action: 'organization.mode.create',
          actor_email: ctx.user.google_user_email,
          actor_id: ctx.user.id,
          actor_name: ctx.user.google_user_name,
          message: `Created mode "${name}" with slug "${slug}": ${JSON.stringify(config)}`,
          organization_id: organizationId,
          tx,
        });
      });

      if (!createdMode) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Mode creation failed' });
      }

      return { mode: createdMode };
    }),

  list: organizationMemberProcedure.input(OrganizationIdInputSchema).query(async ({ input }) => {
    const { organizationId } = input;

    return await db.transaction(
      async tx => ({ modes: await getAllOrganizationModes(organizationId, tx) }),
      { isolationLevel: 'repeatable read', accessMode: 'read only' }
    );
  }),

  getById: organizationMemberProcedure.input(ModeIdInputSchema).query(async ({ input }) => {
    const { modeId, organizationId } = input;

    return await db.transaction(
      async tx => {
        const mode = await getOrganizationModeById(organizationId, modeId, tx);

        if (!mode) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Mode not found',
          });
        }

        return { mode };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' }
    );
  }),

  update: organizationMemberMutationProcedure
    .input(UpdateModeInputSchema)
    .mutation(async ({ input, ctx }) => {
      const { modeId, organizationId, ...updates } = input;

      const organization = await getOrganizationById(organizationId);
      if (!organization) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      let existingMode: OrganizationMode | undefined;
      let updatedMode: OrganizationMode | null | undefined;
      await db.transaction(async tx => {
        await mutateOrganizationSettings(
          organizationId,
          async lockedOrganization => {
            const lockedMode = await getOrganizationModeById(organizationId, modeId, tx, true);
            if (!lockedMode) {
              throw new TRPCError({
                code: 'NOT_FOUND',
                message: 'Mode not found',
              });
            }
            existingMode = lockedMode;

            const orgAutoModel = getOrganizationAutoSettings(lockedOrganization.settings);
            const routes = { ...orgAutoModel.routes };
            const nextSlug = updates.slug ?? lockedMode.slug;
            const slugChanged = nextSlug !== lockedMode.slug;
            const sourceHasRoute = hasRoute(routes, lockedMode.slug);

            let nextSettings = lockedOrganization.settings;

            if (sourceHasRoute && slugChanged) {
              await assertOrganizationAutoWriteEnabled(ctx.user.id);
              await ensureOrganizationAccess(ctx, organizationId, ['owner', 'billing_manager']);
              if (hasRoute(routes, nextSlug)) {
                throw new TRPCError({
                  code: 'CONFLICT',
                  message: `Organization Auto route already exists for mode "${nextSlug}"`,
                });
              }

              const targetModelId = routes[lockedMode.slug];
              delete routes[lockedMode.slug];
              routes[nextSlug] = targetModelId;
              nextSettings = {
                ...lockedOrganization.settings,
                org_auto_model: {
                  ...orgAutoModel,
                  routes,
                },
              };
            }

            updatedMode = await updateOrganizationMode(organizationId, modeId, updates, tx);

            if (!updatedMode) {
              throw new TRPCError({
                code: 'CONFLICT',
                message: `A mode with slug "${updates.slug}" already exists in this organization`,
              });
            }

            return nextSettings;
          },
          tx
        );

        if (!existingMode) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Mode update failed' });
        }

        await createAuditLog({
          action: 'organization.mode.update',
          actor_email: ctx.user.google_user_email,
          actor_id: ctx.user.id,
          actor_name: ctx.user.google_user_name,
          message: createModeUpdateAuditMessage(existingMode, updates),
          organization_id: existingMode.organization_id,
          tx,
        });
      });

      if (!updatedMode) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Mode update failed' });
      }

      return { mode: updatedMode };
    }),

  delete: organizationMemberMutationProcedure
    .input(DeleteModeInputSchema)
    .mutation(async ({ input, ctx }) => {
      const { modeId, organizationId } = input;

      const organization = await getOrganizationById(organizationId);
      if (!organization) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      await db.transaction(async tx => {
        const settings = await mutateOrganizationSettings(
          organizationId,
          async lockedOrganization => {
            const lockedMode = await getOrganizationModeById(organizationId, modeId, tx, true);
            if (!lockedMode) {
              throw new TRPCError({
                code: 'NOT_FOUND',
                message: 'Mode not found',
              });
            }

            const orgAutoModel = getOrganizationAutoSettings(lockedOrganization.settings);
            if (hasRoute(orgAutoModel.routes, lockedMode.slug)) {
              await assertOrganizationAutoWriteEnabled(ctx.user.id);
              await ensureOrganizationAccess(ctx, organizationId, ['owner', 'billing_manager']);
              const routes = { ...orgAutoModel.routes };
              delete routes[lockedMode.slug];
              await deleteOrganizationMode(modeId, tx);
              await createAuditLog({
                action: 'organization.mode.delete',
                actor_email: ctx.user.google_user_email,
                actor_id: ctx.user.id,
                actor_name: ctx.user.google_user_name,
                message: `Deleted mode "${lockedMode.name}" (slug: "${lockedMode.slug}")`,
                organization_id: lockedMode.organization_id,
                tx,
              });
              return {
                ...lockedOrganization.settings,
                org_auto_model: {
                  ...orgAutoModel,
                  routes,
                },
              };
            }

            await deleteOrganizationMode(modeId, tx);
            await createAuditLog({
              action: 'organization.mode.delete',
              actor_email: ctx.user.google_user_email,
              actor_id: ctx.user.id,
              actor_name: ctx.user.google_user_name,
              message: `Deleted mode "${lockedMode.name}" (slug: "${lockedMode.slug}")`,
              organization_id: lockedMode.organization_id,
              tx,
            });
            return lockedOrganization.settings;
          },
          tx
        );

        return settings;
      });

      return successResult();
    }),
});
