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
  projectOrganizationAutoRouteIntoMode,
  projectOrganizationAutoRoutesIntoModes,
  validateOrganizationAutoTarget,
} from '@/lib/organizations/organization-auto-model';

const MAX_ORGANIZATION_AUTO_ROUTES = 100;

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

function hasRoute(routes: Record<string, string>, slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(routes, slug);
}

function assertOrganizationAutoRouteCount(routes: Record<string, string>): void {
  if (Object.keys(routes).length > MAX_ORGANIZATION_AUTO_ROUTES) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Organization Auto supports at most ${MAX_ORGANIZATION_AUTO_ROUTES} routes`,
    });
  }
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

function assertModeDefaultModelCanBeSet(
  organization: NonNullable<Awaited<ReturnType<typeof getOrganizationById>>>
): void {
  if (organization.plan !== 'enterprise') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Model access configuration is not available for this organization.',
    });
  }
}

async function validateModeRouteTarget(
  organization: NonNullable<Awaited<ReturnType<typeof getOrganizationById>>>,
  targetModelId: string
): Promise<string> {
  const validation = await validateOrganizationAutoTarget(organization, targetModelId);
  if (validation.kind === 'ok') {
    return validation.modelId;
  }

  if (validation.message.includes('is not a concrete model identifier')) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Default model '${targetModelId}' is not a concrete model identifier`,
    });
  }

  if (validation.message.includes("is not allowed by the organization's model policy")) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Default model '${targetModelId}' is not in the organization's allowed models list`,
    });
  }

  throw new TRPCError({ code: 'BAD_REQUEST', message: validation.message });
}

function getOrganizationAutoSettings(
  settings: OrganizationSettings
): typeof DEFAULT_ORGANIZATION_AUTO_MODEL_SETTINGS {
  return settings.org_auto_model ?? DEFAULT_ORGANIZATION_AUTO_MODEL_SETTINGS;
}

function createModeUpdateAuditMessage(
  existingMode: OrganizationMode,
  updates: { name?: string; slug?: string; config?: ModeUpdateConfigInput },
  normalizedConfig: Partial<OrganizationModeConfig> | undefined
): string {
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

  return `Updated mode "${existingMode.name}"${changes.length > 0 ? `: ${changes.join(', ')}` : ''}`;
}

export const organizationModesRouter = createTRPCRouter({
  create: organizationMemberMutationProcedure
    .input(CreateModeInputSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId, name, slug, config } = input;
      const defaultModelChange = getDefaultModelChange(config);

      const organization = await getOrganizationById(organizationId);
      if (!organization) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      if (defaultModelChange.kind !== 'none') {
        await assertOrganizationAutoWriteEnabled(ctx.user.id);
        await ensureOrganizationAccess(ctx, organizationId, ['owner', 'billing_manager']);
      }

      let createdMode: OrganizationMode | null | undefined;
      const settings = await db.transaction(async tx => {
        const settings = await mutateOrganizationSettings(
          organizationId,
          async lockedOrganization => {
            let nextSettings = lockedOrganization.settings;

            if (defaultModelChange.kind === 'set') {
              assertModeDefaultModelCanBeSet(lockedOrganization);
              const targetModelId = await validateModeRouteTarget(
                lockedOrganization,
                defaultModelChange.defaultModel
              );
              const orgAutoModel = getOrganizationAutoSettings(lockedOrganization.settings);
              const routes = { ...orgAutoModel.routes, [slug]: targetModelId };
              assertOrganizationAutoRouteCount(routes);
              nextSettings = {
                ...lockedOrganization.settings,
                org_auto_model: {
                  ...orgAutoModel,
                  routes,
                },
              };
            }

            if (defaultModelChange.kind === 'clear') {
              const orgAutoModel = getOrganizationAutoSettings(lockedOrganization.settings);
              const routes = { ...orgAutoModel.routes };
              delete routes[slug];
              nextSettings = {
                ...lockedOrganization.settings,
                org_auto_model: {
                  ...orgAutoModel,
                  routes,
                },
              };
            }

            createdMode = await createOrganizationMode(
              organizationId,
              ctx.user.id,
              name,
              slug,
              normalizeModeConfig(config),
              tx
            );

            if (!createdMode) {
              throw new TRPCError({
                code: 'CONFLICT',
                message: `A mode with slug "${slug}" already exists in this organization`,
              });
            }

            return nextSettings;
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

        return settings;
      });

      if (!createdMode) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Mode creation failed' });
      }

      return { mode: projectOrganizationAutoRouteIntoMode(createdMode, settings) };
    }),

  list: organizationMemberProcedure.input(OrganizationIdInputSchema).query(async ({ input }) => {
    const { organizationId } = input;

    return await db.transaction(
      async tx => {
        const [modes, organization] = await Promise.all([
          getAllOrganizationModes(organizationId, tx),
          getOrganizationById(organizationId, tx),
        ]);

        return {
          modes: organization
            ? projectOrganizationAutoRoutesIntoModes(modes, organization.settings)
            : modes,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' }
    );
  }),

  getById: organizationMemberProcedure.input(ModeIdInputSchema).query(async ({ input }) => {
    const { modeId, organizationId } = input;

    return await db.transaction(
      async tx => {
        const [mode, organization] = await Promise.all([
          getOrganizationModeById(organizationId, modeId, tx),
          getOrganizationById(organizationId, tx),
        ]);

        if (!mode) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Mode not found',
          });
        }

        return {
          mode: organization
            ? projectOrganizationAutoRouteIntoMode(mode, organization.settings)
            : mode,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' }
    );
  }),

  update: organizationMemberMutationProcedure
    .input(UpdateModeInputSchema)
    .mutation(async ({ input, ctx }) => {
      const { modeId, organizationId, ...updates } = input;
      const defaultModelChange = getDefaultModelChange(updates.config);
      const normalizedConfig = normalizeModeConfig(updates.config);

      const organization = await getOrganizationById(organizationId);
      if (!organization) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      if (defaultModelChange.kind !== 'none') {
        await assertOrganizationAutoWriteEnabled(ctx.user.id);
        await ensureOrganizationAccess(ctx, organizationId, ['owner', 'billing_manager']);
      }

      let existingMode: OrganizationMode | undefined;
      let updatedMode: OrganizationMode | null | undefined;
      const settings = await db.transaction(async tx => {
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
            existingMode = lockedMode;

            const orgAutoModel = getOrganizationAutoSettings(lockedOrganization.settings);
            const routes = { ...orgAutoModel.routes };
            const nextSlug = updates.slug ?? lockedMode.slug;
            const slugChanged = nextSlug !== lockedMode.slug;
            const sourceHasRoute = hasRoute(routes, lockedMode.slug);
            let routeChanged = false;

            if (sourceHasRoute && slugChanged) {
              await assertOrganizationAutoWriteEnabled(ctx.user.id);
              await ensureOrganizationAccess(ctx, organizationId, ['owner', 'billing_manager']);
              if (hasRoute(routes, nextSlug)) {
                throw new TRPCError({
                  code: 'CONFLICT',
                  message: `Organization Auto route already exists for mode "${nextSlug}"`,
                });
              }
            }

            if (defaultModelChange.kind === 'set') {
              assertModeDefaultModelCanBeSet(lockedOrganization);
              const targetModelId = await validateModeRouteTarget(
                lockedOrganization,
                defaultModelChange.defaultModel
              );
              if (sourceHasRoute && slugChanged) {
                delete routes[lockedMode.slug];
              }
              routes[nextSlug] = targetModelId;
              assertOrganizationAutoRouteCount(routes);
              routeChanged = true;
            } else if (defaultModelChange.kind === 'clear') {
              if (sourceHasRoute) {
                delete routes[lockedMode.slug];
                routeChanged = true;
              }
            } else if (sourceHasRoute && slugChanged) {
              const targetModelId = await validateModeRouteTarget(
                lockedOrganization,
                routes[lockedMode.slug]
              );
              delete routes[lockedMode.slug];
              routes[nextSlug] = targetModelId;
              routeChanged = true;
            }

            const nextSettings = routeChanged
              ? {
                  ...lockedOrganization.settings,
                  org_auto_model: {
                    ...orgAutoModel,
                    routes,
                  },
                }
              : lockedOrganization.settings;

            updatedMode = await updateOrganizationMode(
              organizationId,
              modeId,
              {
                ...updates,
                config: normalizedConfig,
              },
              tx
            );

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
          message: createModeUpdateAuditMessage(existingMode, updates, normalizedConfig),
          organization_id: existingMode.organization_id,
          tx,
        });

        return settings;
      });

      if (!updatedMode) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Mode update failed' });
      }

      return { mode: projectOrganizationAutoRouteIntoMode(updatedMode, settings) };
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
