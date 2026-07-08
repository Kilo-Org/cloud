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
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import type { Organization } from '@kilocode/db/schema';
import {
  DEFAULT_ORGANIZATION_AUTO_MODEL_SETTINGS,
  MAX_ORGANIZATION_AUTO_ROUTES,
  assertOrganizationAutoEligible,
  assertOrganizationAutoWriteEnabled,
  hasOrganizationAutoRoute,
  validateOrganizationAutoTarget,
} from '@/lib/organizations/organization-auto-model';

const ModeConfigInputSchema = OrganizationModeConfigSchema.partial();
const RouteModelInputSchema = z
  .string()
  .trim()
  .nullable()
  .transform(value => (value === '' ? null : value))
  .optional();

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
  route_model: RouteModelInputSchema,
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
  route_model: RouteModelInputSchema,
});

const DeleteModeInputSchema = OrganizationIdInputSchema.extend({
  modeId: z.uuid(),
  preserve_route: z.boolean().optional(),
  route_model: RouteModelInputSchema,
});

const ModeIdInputSchema = OrganizationIdInputSchema.extend({
  modeId: z.uuid(),
});

const BUILT_IN_MODE_SLUGS = new Set(['architect', 'code', 'ask', 'debug', 'orchestrator']);

function getOrganizationAutoSettings(
  settings: OrganizationSettings
): typeof DEFAULT_ORGANIZATION_AUTO_MODEL_SETTINGS {
  return settings.org_auto_model ?? DEFAULT_ORGANIZATION_AUTO_MODEL_SETTINGS;
}

type OrganizationAccessContext = Parameters<typeof ensureOrganizationAccess>[0];

async function applyOrganizationAutoRouteChange(
  organization: Pick<Organization, 'id' | 'settings' | 'plan'>,
  modeSlug: string,
  routeModel: string | null,
  ctx: OrganizationAccessContext,
  tx?: DrizzleTransaction
): Promise<OrganizationSettings> {
  await assertOrganizationAutoWriteEnabled(ctx.user.id);
  assertOrganizationAutoEligible(organization);
  await ensureOrganizationAccess(ctx, organization.id, ['owner']);
  const orgAutoModel = getOrganizationAutoSettings(organization.settings);
  const currentRoute = orgAutoModel.routes[modeSlug];
  if (routeModel === null && !currentRoute) {
    return organization.settings;
  }

  const routes = { ...orgAutoModel.routes };
  if (routeModel === null) {
    delete routes[modeSlug];
  } else {
    const validation = await validateOrganizationAutoTarget(organization, routeModel, {
      dbClient: tx,
    });

    if (validation.kind === 'error') {
      throw new TRPCError({ code: 'BAD_REQUEST', message: validation.message });
    }
    if (currentRoute === validation.modelId) {
      return organization.settings;
    }
    routes[modeSlug] = validation.modelId;
  }

  if (Object.keys(routes).length > MAX_ORGANIZATION_AUTO_ROUTES) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Organization Auto supports at most ${MAX_ORGANIZATION_AUTO_ROUTES} routes.`,
    });
  }

  return {
    ...organization.settings,
    org_auto_model: { ...orgAutoModel, routes },
  };
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
      const { organizationId, name, slug, config, route_model } = input;
      const organization = await getOrganizationById(organizationId);
      if (!organization) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      if (route_model !== undefined) {
        await assertOrganizationAutoWriteEnabled(ctx.user.id);
        assertOrganizationAutoEligible(organization);
        await ensureOrganizationAccess(ctx, organizationId, ['owner']);
      }

      let createdMode: OrganizationMode | null | undefined;
      let routeAuditMessage: string | undefined;
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

            if (route_model === undefined) {
              return lockedOrganization.settings;
            }
            const previousRoute =
              lockedOrganization.settings.org_auto_model?.routes[createdMode.slug];
            const nextSettings = await applyOrganizationAutoRouteChange(
              lockedOrganization,
              createdMode.slug,
              route_model,
              ctx,
              tx
            );

            const nextRoute = nextSettings.org_auto_model?.routes[createdMode.slug];
            if (previousRoute !== nextRoute) {
              routeAuditMessage = nextRoute
                ? `Organization Auto route set: "${createdMode.slug}" → "${nextRoute}"`
                : `Organization Auto route cleared: "${createdMode.slug}"${previousRoute ? ` (was "${previousRoute}")` : ''}`;
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
          message: `Created mode "${name}" with slug "${slug}": ${JSON.stringify(config)}${routeAuditMessage ? `, ${routeAuditMessage}` : ''}`,
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

    return { modes: await getAllOrganizationModes(organizationId) };
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
      const { modeId, organizationId, route_model, ...updates } = input;

      const organization = await getOrganizationById(organizationId);
      if (!organization) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      if (route_model !== undefined) {
        await assertOrganizationAutoWriteEnabled(ctx.user.id);
        assertOrganizationAutoEligible(organization);
        await ensureOrganizationAccess(ctx, organizationId, ['owner']);
      }

      const hasModeUpdates =
        updates.name !== undefined || updates.slug !== undefined || updates.config !== undefined;
      let existingMode: OrganizationMode | undefined;
      let updatedMode: OrganizationMode | null | undefined;
      const routeAuditChanges: string[] = [];
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
            const sourceHasRoute = hasOrganizationAutoRoute(routes, lockedMode.slug);
            const initialRoute = routes[lockedMode.slug];

            let nextSettings = lockedOrganization.settings;

            if (sourceHasRoute && slugChanged) {
              await ensureOrganizationAccess(ctx, organizationId, ['owner']);
              if (hasOrganizationAutoRoute(routes, nextSlug)) {
                throw new TRPCError({
                  code: 'CONFLICT',
                  message: `Organization Auto route already exists for mode "${nextSlug}"`,
                });
              }

              const targetModelId = routes[lockedMode.slug];
              delete routes[lockedMode.slug];
              routes[nextSlug] = targetModelId;
              routeAuditChanges.push(
                `Organization Auto route migrated: "${lockedMode.slug}" → "${nextSlug}" (${targetModelId})`
              );

              nextSettings = {
                ...lockedOrganization.settings,
                org_auto_model: {
                  ...orgAutoModel,
                  routes,
                },
              };
            }

            if (hasModeUpdates) {
              updatedMode = await updateOrganizationMode(organizationId, modeId, updates, tx);

              if (!updatedMode) {
                throw new TRPCError({
                  code: 'CONFLICT',
                  message: `A mode with slug "${updates.slug}" already exists in this organization`,
                });
              }
            } else if (route_model !== undefined) {
              updatedMode = lockedMode;
            } else {
              throw new TRPCError({ code: 'BAD_REQUEST', message: 'No mode updates provided' });
            }

            if (route_model !== undefined) {
              const previousRoute = nextSettings.org_auto_model?.routes[nextSlug];
              nextSettings = await applyOrganizationAutoRouteChange(
                { ...lockedOrganization, settings: nextSettings },
                nextSlug,
                route_model,
                ctx,
                tx
              );
              const nextRoute = nextSettings.org_auto_model?.routes[nextSlug];
              if (previousRoute !== nextRoute) {
                if (slugChanged) {
                  routeAuditChanges.length = 0;
                  routeAuditChanges.push(
                    nextRoute
                      ? `Organization Auto route: "${lockedMode.slug}"${initialRoute ? ` "${initialRoute}"` : ''} → "${nextSlug}" "${nextRoute}"`
                      : `Organization Auto route removed: "${lockedMode.slug}"${initialRoute ? ` (was "${initialRoute}")` : ''}`
                  );
                } else {
                  routeAuditChanges.push(
                    nextRoute
                      ? `Organization Auto route: "${nextSlug}" ${previousRoute ? `"${previousRoute}" → ` : 'set to '}"${nextRoute}"`
                      : `Organization Auto route cleared: "${nextSlug}"${previousRoute ? ` (was "${previousRoute}")` : ''}`
                  );
                }
              }
            }

            return nextSettings;
          },
          tx
        );

        if (!existingMode) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Mode update failed' });
        }

        if (hasModeUpdates || routeAuditChanges.length > 0) {
          await createAuditLog({
            action: 'organization.mode.update',
            actor_email: ctx.user.google_user_email,
            actor_id: ctx.user.id,
            actor_name: ctx.user.google_user_name,
            message: `${createModeUpdateAuditMessage(existingMode, updates)}${routeAuditChanges.length > 0 ? `, ${routeAuditChanges.join(', ')}` : ''}`,
            organization_id: existingMode.organization_id,
            tx,
          });
        }
      });

      if (!updatedMode) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Mode update failed' });
      }

      return { mode: updatedMode };
    }),

  delete: organizationMemberMutationProcedure
    .input(DeleteModeInputSchema)
    .mutation(async ({ input, ctx }) => {
      const { modeId, organizationId, preserve_route = false, route_model } = input;

      const organization = await getOrganizationById(organizationId);
      if (!organization) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      if (route_model !== undefined) {
        await assertOrganizationAutoWriteEnabled(ctx.user.id);
        assertOrganizationAutoEligible(organization);
        await ensureOrganizationAccess(ctx, organizationId, ['owner']);
      }

      const routeAuditChanges: string[] = [];
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
            let nextSettings = lockedOrganization.settings;

            const preserveBuiltInRoute = preserve_route && BUILT_IN_MODE_SLUGS.has(lockedMode.slug);
            const hasExistingRoute = hasOrganizationAutoRoute(orgAutoModel.routes, lockedMode.slug);

            if (route_model !== undefined && !preserveBuiltInRoute) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'Route updates can only be preserved when reverting a built-in mode.',
              });
            }

            if (route_model !== undefined) {
              const previousRoute =
                lockedOrganization.settings.org_auto_model?.routes[lockedMode.slug];
              nextSettings = await applyOrganizationAutoRouteChange(
                lockedOrganization,
                lockedMode.slug,
                route_model,
                ctx,
                tx
              );
              const nextRoute = nextSettings.org_auto_model?.routes[lockedMode.slug];
              if (previousRoute !== nextRoute) {
                routeAuditChanges.push(
                  nextRoute
                    ? `Organization Auto route: "${lockedMode.slug}" ${previousRoute ? `"${previousRoute}" → ` : 'set to '}"${nextRoute}"`
                    : `Organization Auto route cleared: "${lockedMode.slug}"${previousRoute ? ` (was "${previousRoute}")` : ''}`
                );
              }
            } else if (hasExistingRoute) {
              await ensureOrganizationAccess(ctx, organizationId, ['owner']);

              if (!preserveBuiltInRoute) {
                routeAuditChanges.push(
                  `Organization Auto route removed: "${lockedMode.slug}" (was "${orgAutoModel.routes[lockedMode.slug]}")`
                );
                const routes = { ...orgAutoModel.routes };
                delete routes[lockedMode.slug];
                nextSettings = {
                  ...lockedOrganization.settings,
                  org_auto_model: {
                    ...orgAutoModel,
                    routes,
                  },
                };
              } else {
                routeAuditChanges.push(
                  `Organization Auto route preserved: "${lockedMode.slug}" (${orgAutoModel.routes[lockedMode.slug]})`
                );
              }
            }

            await deleteOrganizationMode(modeId, tx);
            await createAuditLog({
              action: 'organization.mode.delete',
              actor_email: ctx.user.google_user_email,
              actor_id: ctx.user.id,
              actor_name: ctx.user.google_user_name,
              message: `Deleted mode "${lockedMode.name}" (slug: "${lockedMode.slug}")${routeAuditChanges.length > 0 ? `, ${routeAuditChanges.join(', ')}` : ''}`,

              organization_id: lockedMode.organization_id,
              tx,
            });
            return nextSettings;
          },
          tx
        );

        return settings;
      });

      return successResult();
    }),
});
