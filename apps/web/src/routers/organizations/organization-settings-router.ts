import { getOrganizationById, mutateOrganizationSettings } from '@/lib/organizations/organizations';
import type {
  OpenRouterModelsResponse,
  OrganizationSettings,
} from '@/lib/organizations/organization-types';
import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  OrganizationIdInputSchema,
  organizationBillingMutationProcedure,
  organizationMemberProcedure,
} from '@/routers/organizations/utils';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { KILO_ORGANIZATION_ID } from '@/lib/organizations/constants';
import { createAllowPredicateFromRestrictions } from '@/lib/model-allow.server';
import { getAvailableModelsForOrganization } from '@/lib/organizations/organization-models';
import { getEffectiveModelRestrictions } from '@/lib/organizations/model-restrictions';
import { normalizeModelId } from '@/lib/ai-gateway/model-utils';
import { isReleaseToggleEnabled } from '@/lib/posthog-feature-flags';
import { db } from '@/lib/drizzle';
import { ORG_AUTO_MODEL } from '@/lib/ai-gateway/auto-model';
import {
  DEFAULT_ORGANIZATION_AUTO_MODEL_SETTINGS,
  ORGANIZATION_AUTO_MODEL_FLAG,
  MAX_ORGANIZATION_AUTO_ROUTES,
  isOrganizationAutoEligible,
  validateOrganizationAutoTarget,
} from '@/lib/organizations/organization-auto-model';

/**
 * Allowlist of organization IDs that are allowed to modify experimental settings
 */
const PRIVILEGED_ORGANIZATION_IDS = [
  KILO_ORGANIZATION_ID, // production kilo code org
  '03366a2a-b498-498a-8560-98bffe4a0997', // john's local test org
] as const;

/**
 * Creates a human-readable diff message for model/provider access changes
 */
function createAccessListsDiffMessage(
  oldSettings: OrganizationSettings | undefined,
  newSettings: OrganizationSettings
): string {
  const changes: string[] = [];
  const old = oldSettings || {};

  if (old.model_deny_list !== newSettings.model_deny_list) {
    const oldModels = new Set(old.model_deny_list || []);
    const newModels = new Set(newSettings.model_deny_list || []);

    const added = [...newModels].filter(model => !oldModels.has(model));
    const removed = [...oldModels].filter(model => !newModels.has(model));

    if (added.length > 0) {
      changes.push(`Denied models: ${added.join(', ')}`);
    }
    if (removed.length > 0) {
      changes.push(`Allowed models: ${removed.join(', ')}`);
    }
  }

  if (old.provider_allow_list !== newSettings.provider_allow_list) {
    const oldProviders = new Set(old.provider_allow_list || []);
    const newProviders = new Set(newSettings.provider_allow_list || []);

    const added = [...newProviders].filter(provider => !oldProviders.has(provider));
    const removed = [...oldProviders].filter(provider => !newProviders.has(provider));

    if (added.length > 0) {
      changes.push(`Allowed providers: ${added.join(', ')}`);
    }
    if (removed.length > 0) {
      changes.push(`Disallowed providers: ${removed.join(', ')}`);
    }
  }

  return changes.length > 0 ? changes.join('; ') : 'Updated access lists';
}

/**
 * Creates a human-readable diff message for default model changes
 */
function createDefaultModelDiffMessage(
  oldSettings: OrganizationSettings | undefined,
  newSettings: OrganizationSettings
): string {
  const old = oldSettings || {};

  if (old.default_model !== newSettings.default_model) {
    if (old.default_model && newSettings.default_model) {
      return `Changed default model: ${old.default_model} → ${newSettings.default_model}`;
    } else if (newSettings.default_model) {
      return `Set default model: ${newSettings.default_model}`;
    } else {
      return `Removed default model: ${old.default_model}`;
    }
  }

  return 'Updated default model';
}

function assertOrganizationAutoRouteCount(routes: Record<string, string>): void {
  if (Object.keys(routes).length > MAX_ORGANIZATION_AUTO_ROUTES) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Organization Auto supports at most ${MAX_ORGANIZATION_AUTO_ROUTES} routes`,
    });
  }
}

const UpdateAllowListsInputSchema = OrganizationIdInputSchema.extend({
  provider_allow_list: z.array(z.string()).optional(),
  model_deny_list: z.array(z.string()).optional(),
});

function dedupeModels(values: string[]): string[] {
  return [...new Set(values.map(value => normalizeModelId(value)))];
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

// Organization Auto rollout is intentionally actor-scoped so flagged admins can
// configure eligible organizations before the broader rollout is enabled.
async function assertOrganizationAutoWriteEnabled(userId: string): Promise<void> {
  if (
    process.env.NODE_ENV !== 'development' &&
    !(await isReleaseToggleEnabled(ORGANIZATION_AUTO_MODEL_FLAG, userId))
  ) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Organization Auto configuration is not available',
    });
  }
}

function assertOrganizationAutoEligible(
  organization: NonNullable<Awaited<ReturnType<typeof getOrganizationById>>>
): void {
  if (!isOrganizationAutoEligible(organization)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Organization Auto is only available for Enterprise organizations.',
    });
  }
}

async function validateOrganizationDefaultModel(
  organization: NonNullable<Awaited<ReturnType<typeof getOrganizationById>>>,
  defaultModel: string
): Promise<string> {
  const requestedDefaultModel = defaultModel.trim().toLowerCase();
  const normalizedDefaultModel = normalizeModelId(requestedDefaultModel);
  if (!normalizedDefaultModel || normalizedDefaultModel.endsWith('/*')) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Default model '${defaultModel}' is not a concrete model identifier`,
    });
  }

  if (normalizedDefaultModel === ORG_AUTO_MODEL.id) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Enable Organization Auto through its dedicated controls.',
    });
  }

  const isAllowed = createAllowPredicateFromRestrictions(
    getEffectiveModelRestrictions(organization)
  );
  if (!(await isAllowed(requestedDefaultModel))) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Default model '${defaultModel}' is not in the organization's allowed models list`,
    });
  }

  return defaultModel.trim();
}

async function validateOrganizationDefaultReplacement(
  organization: NonNullable<Awaited<ReturnType<typeof getOrganizationById>>>,
  replacementModel: string
): Promise<string> {
  const normalizedReplacementModel = normalizeModelId(replacementModel.trim().toLowerCase());
  if (normalizedReplacementModel === ORG_AUTO_MODEL.id) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Choose a replacement model other than Organization Auto.',
    });
  }

  const validatedReplacementModel = await validateOrganizationDefaultModel(
    organization,
    replacementModel
  );
  let availableModels: Awaited<ReturnType<typeof getAvailableModelsForOrganization>>;
  try {
    availableModels = await getAvailableModelsForOrganization(organization.id);
  } catch {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        'Replacement default model could not be validated against the current model catalog.',
    });
  }
  const availableModel = availableModels?.data.find(
    model => model.id.trim().toLowerCase() === validatedReplacementModel.toLowerCase()
  );
  if (!availableModel) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Default model '${replacementModel}' is unavailable for this organization.`,
    });
  }

  return availableModel.id;
}

const UpdateDefaultModelInputSchema = OrganizationIdInputSchema.extend({
  default_model: z.string().or(z.null()),
});

const EnableOrganizationAutoInputSchema = OrganizationIdInputSchema;

const DisableOrganizationAutoInputSchema = OrganizationIdInputSchema.extend({
  replacement_model: z.string().min(1),
});

const SetOrganizationAutoRouteInputSchema = OrganizationIdInputSchema.extend({
  mode_slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/, 'Mode slug must contain only lowercase letters, numbers, and hyphens'),
  model_id: z.string().min(1).max(200),
});

const ClearOrganizationAutoRouteInputSchema = OrganizationIdInputSchema.extend({
  mode_slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/, 'Mode slug must contain only lowercase letters, numbers, and hyphens'),
});

const SetOrganizationAutoFallbackInputSchema = OrganizationIdInputSchema.extend({
  model_id: z.string().min(1).max(200),
});

const ConfigureOrganizationDefaultBehaviorInputSchema = OrganizationIdInputSchema.extend({
  behavior: z.enum(['auto', 'specific', 'global']),
  fallback_model: z.string().min(1).max(200).optional(),
  specific_model: z.string().min(1).max(200).optional(),
});

const UpdateDataCollectionInputSchema = OrganizationIdInputSchema.extend({
  dataCollection: z.enum(['allow', 'deny']).nullable(),
});

const UpdateCodeIndexingEnabledInputSchema = OrganizationIdInputSchema.extend({
  code_indexing_enabled: z.boolean(),
});

const UpdateProjectsUIEnabledInputSchema = OrganizationIdInputSchema.extend({
  projects_ui_enabled: z.boolean(),
});

const UpdateMinimumBalanceAlertInputSchema = OrganizationIdInputSchema.extend({
  enabled: z.boolean(),
  minimum_balance: z.number().positive().optional(),
  minimum_balance_alert_email: z.array(z.string().email()).optional(),
}).refine(
  data => {
    if (data.enabled) {
      return (
        data.minimum_balance !== undefined &&
        data.minimum_balance_alert_email !== undefined &&
        data.minimum_balance_alert_email.length > 0
      );
    }
    return true;
  },
  {
    message:
      'When enabled is true, minimum_balance must be a positive number and minimum_balance_alert_email must have at least one email',
  }
);

const SettingsResponseSchema = z.object({
  settings: z.custom<OrganizationSettings>(),
});

export const organizationsSettingsRouter = createTRPCRouter({
  listAvailableModels: organizationMemberProcedure
    .input(OrganizationIdInputSchema)
    .output(z.custom<OpenRouterModelsResponse>())
    .query(async ({ input }) => {
      const { organizationId } = input;

      const result = await getAvailableModelsForOrganization(organizationId);
      if (!result) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }
      return result;
    }),

  updateAllowLists: organizationBillingMutationProcedure
    .input(UpdateAllowListsInputSchema)
    .output(SettingsResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId, provider_allow_list, model_deny_list } = input;
      const existingOrg = await getOrganizationById(organizationId);
      if (!existingOrg) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
      }
      if (existingOrg.plan !== 'enterprise') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Model access configuration is not available for this organization.',
        });
      }

      let previousSettings: OrganizationSettings | undefined;
      const updatedSettings = await db.transaction(async tx => {
        const settings = await mutateOrganizationSettings(
          organizationId,
          async organization => {
            if (organization.plan !== 'enterprise') {
              throw new TRPCError({
                code: 'FORBIDDEN',
                message: 'Model access configuration is not available for this organization.',
              });
            }
            previousSettings = organization.settings;
            const currentSettings = organization.settings || {};
            const settingsUpdate: OrganizationSettings = { ...currentSettings };
            if (provider_allow_list !== undefined) {
              settingsUpdate.provider_allow_list = dedupeStrings(provider_allow_list);
            }
            if (model_deny_list !== undefined) {
              settingsUpdate.model_deny_list = dedupeModels(model_deny_list);
            }
            if (
              (provider_allow_list !== undefined || model_deny_list !== undefined) &&
              currentSettings.default_model &&
              currentSettings.default_model !== ORG_AUTO_MODEL.id
            ) {
              const isAllowed = createAllowPredicateFromRestrictions({
                providerAllowList: settingsUpdate.provider_allow_list,
                modelDenyList: settingsUpdate.model_deny_list ?? [],
              });
              if (!(await isAllowed(currentSettings.default_model))) {
                settingsUpdate.default_model = undefined;
              }
            }
            return settingsUpdate;
          },
          tx
        );
        await createAuditLog({
          action: 'organization.settings.change',
          actor_email: ctx.user.google_user_email,
          actor_id: ctx.user.id,
          actor_name: ctx.user.google_user_name,
          message: createAccessListsDiffMessage(previousSettings, settings),
          organization_id: organizationId,
          tx,
        });
        return settings;
      });
      return { settings: updatedSettings };
    }),

  updateDefaultModel: organizationBillingMutationProcedure
    .input(UpdateDefaultModelInputSchema)
    .output(SettingsResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId, default_model } = input;
      const existingOrg = await getOrganizationById(organizationId);
      if (!existingOrg) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
      }
      if (existingOrg.plan !== 'enterprise') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Model access configuration is not available for this organization.',
        });
      }
      if (existingOrg.settings.default_model === ORG_AUTO_MODEL.id) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Disable Organization Auto through its dedicated controls.',
        });
      }

      let validatedDefaultModel: string | undefined;
      let previousSettings: OrganizationSettings | undefined;
      const updatedSettings = await db.transaction(async tx => {
        const settings = await mutateOrganizationSettings(
          organizationId,
          async organization => {
            if (organization.plan !== 'enterprise') {
              throw new TRPCError({
                code: 'FORBIDDEN',
                message: 'Model access configuration is not available for this organization.',
              });
            }
            if (organization.settings.default_model === ORG_AUTO_MODEL.id) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'Disable Organization Auto through its dedicated controls.',
              });
            }
            if (default_model) {
              validatedDefaultModel = await validateOrganizationDefaultModel(
                organization,
                default_model
              );
            } else {
              validatedDefaultModel = undefined;
            }
            previousSettings = organization.settings;
            return {
              ...organization.settings,
              default_model: validatedDefaultModel || undefined,
            };
          },
          tx
        );
        await createAuditLog({
          action: 'organization.settings.change',
          actor_email: ctx.user.google_user_email,
          actor_id: ctx.user.id,
          actor_name: ctx.user.google_user_name,
          message: createDefaultModelDiffMessage(previousSettings, settings),
          organization_id: organizationId,
          tx,
        });
        return settings;
      });
      return { settings: updatedSettings };
    }),

  enableOrganizationAuto: organizationBillingMutationProcedure
    .input(EnableOrganizationAutoInputSchema)
    .output(SettingsResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId } = input;
      await assertOrganizationAutoWriteEnabled(ctx.user.id);

      const existingOrg = await getOrganizationById(organizationId);
      if (!existingOrg) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
      }
      assertOrganizationAutoEligible(existingOrg);

      let didEnableChange = false;
      const updatedSettings = await db.transaction(async tx => {
        const settings = await mutateOrganizationSettings(
          organizationId,
          async organization => {
            assertOrganizationAutoEligible(organization);
            if (
              organization.settings.default_model === ORG_AUTO_MODEL.id &&
              organization.settings.org_auto_model
            ) {
              return organization.settings;
            }
            const existingOrgAutoModel = organization.settings.org_auto_model;
            const freshOrgAutoModel =
              existingOrgAutoModel ?? DEFAULT_ORGANIZATION_AUTO_MODEL_SETTINGS;
            const seededRoutes = { ...freshOrgAutoModel.routes };

            assertOrganizationAutoRouteCount(seededRoutes);
            for (const [slug, targetModelId] of Object.entries(seededRoutes)) {
              const validation = await validateOrganizationAutoTarget(organization, targetModelId, {
                dbClient: tx,
              });
              if (validation.kind === 'error') {
                throw new TRPCError({
                  code: 'BAD_REQUEST',
                  message: `Cannot enable Organization Auto because route "${slug}" is invalid: ${validation.message}`,
                });
              }
              seededRoutes[slug] = validation.modelId;
            }
            const fallbackValidation = await validateOrganizationAutoTarget(
              organization,
              freshOrgAutoModel.fallback_model,
              { dbClient: tx }
            );

            if (fallbackValidation.kind === 'error') {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: `Cannot enable Organization Auto because fallback model is invalid: ${fallbackValidation.message}`,
              });
            }

            const nextSettings = {
              ...organization.settings,
              default_model: ORG_AUTO_MODEL.id,
              org_auto_model: {
                ...freshOrgAutoModel,
                routes: seededRoutes,
                fallback_model: fallbackValidation.modelId,
              },
            };
            if (
              organization.settings.default_model === ORG_AUTO_MODEL.id &&
              JSON.stringify(organization.settings.org_auto_model) ===
                JSON.stringify(nextSettings.org_auto_model)
            ) {
              return organization.settings;
            }
            didEnableChange = true;
            return nextSettings;
          },
          tx
        );
        if (didEnableChange) {
          await createAuditLog({
            action: 'organization.settings.change',
            actor_email: ctx.user.google_user_email,
            actor_id: ctx.user.id,
            actor_name: ctx.user.google_user_name,
            message: 'Enabled Organization Auto and set it as the organization default model.',
            organization_id: organizationId,
            tx,
          });
        }
        return settings;
      });

      return { settings: updatedSettings };
    }),

  disableOrganizationAuto: organizationBillingMutationProcedure
    .input(DisableOrganizationAutoInputSchema)
    .output(SettingsResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId, replacement_model } = input;

      const existingOrg = await getOrganizationById(organizationId);
      if (!existingOrg) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
      }
      assertOrganizationAutoEligible(existingOrg);
      if (existingOrg.settings.default_model !== ORG_AUTO_MODEL.id) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Organization Auto is not enabled for this organization.',
        });
      }

      let normalizedReplacementModel: string | undefined;
      const updatedSettings = await db.transaction(async tx => {
        const settings = await mutateOrganizationSettings(
          organizationId,
          async organization => {
            assertOrganizationAutoEligible(organization);
            if (organization.settings.default_model !== ORG_AUTO_MODEL.id) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'Organization Auto is not enabled for this organization.',
              });
            }
            normalizedReplacementModel = await validateOrganizationDefaultReplacement(
              organization,
              replacement_model
            );
            return {
              ...organization.settings,
              default_model: normalizedReplacementModel,
            };
          },
          tx
        );
        await createAuditLog({
          action: 'organization.settings.change',
          actor_email: ctx.user.google_user_email,
          actor_id: ctx.user.id,
          actor_name: ctx.user.google_user_name,
          message: `Disabled Organization Auto and set replacement default model: ${normalizedReplacementModel}`,
          organization_id: organizationId,
          tx,
        });
        return settings;
      });

      return { settings: updatedSettings };
    }),

  setOrganizationAutoRoute: organizationBillingMutationProcedure
    .input(SetOrganizationAutoRouteInputSchema)
    .output(SettingsResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId, mode_slug, model_id } = input;
      await assertOrganizationAutoWriteEnabled(ctx.user.id);

      const existingOrg = await getOrganizationById(organizationId);
      if (!existingOrg) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
      }
      assertOrganizationAutoEligible(existingOrg);

      let validatedModelId: string | undefined;
      let previousRoute: string | undefined;
      const updatedSettings = await db.transaction(async tx => {
        const settings = await mutateOrganizationSettings(
          organizationId,
          async organization => {
            assertOrganizationAutoEligible(organization);
            const validation = await validateOrganizationAutoTarget(organization, model_id, {
              dbClient: tx,
            });
            if (validation.kind === 'error') {
              throw new TRPCError({ code: 'BAD_REQUEST', message: validation.message });
            }
            validatedModelId = validation.modelId;
            const orgAutoModel =
              organization.settings.org_auto_model ?? DEFAULT_ORGANIZATION_AUTO_MODEL_SETTINGS;
            previousRoute = orgAutoModel.routes[mode_slug];
            if (previousRoute === validation.modelId) {
              return organization.settings;
            }
            const routes = {
              ...orgAutoModel.routes,
              [mode_slug]: validation.modelId,
            };
            assertOrganizationAutoRouteCount(routes);
            return {
              ...organization.settings,
              org_auto_model: {
                ...orgAutoModel,
                routes,
              },
            };
          },
          tx
        );
        if (previousRoute !== validatedModelId) {
          await createAuditLog({
            action: 'organization.settings.change',
            actor_email: ctx.user.google_user_email,
            actor_id: ctx.user.id,
            actor_name: ctx.user.google_user_name,
            message:
              previousRoute === undefined
                ? `Set Organization Auto route for mode "${mode_slug}" to "${validatedModelId}"`
                : `Updated Organization Auto route for mode "${mode_slug}": "${previousRoute}" → "${validatedModelId}"`,
            organization_id: organizationId,
            tx,
          });
        }
        return settings;
      });

      return { settings: updatedSettings };
    }),

  clearOrganizationAutoRoute: organizationBillingMutationProcedure
    .input(ClearOrganizationAutoRouteInputSchema)
    .output(SettingsResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId, mode_slug } = input;
      await assertOrganizationAutoWriteEnabled(ctx.user.id);

      const existingOrg = await getOrganizationById(organizationId);
      if (!existingOrg) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
      }
      assertOrganizationAutoEligible(existingOrg);

      let removedRoute: string | undefined;
      const updatedSettings = await db.transaction(async tx => {
        const settings = await mutateOrganizationSettings(
          organizationId,
          organization => {
            assertOrganizationAutoEligible(organization);
            const orgAutoModel =
              organization.settings.org_auto_model ?? DEFAULT_ORGANIZATION_AUTO_MODEL_SETTINGS;
            removedRoute = orgAutoModel.routes[mode_slug];
            if (removedRoute === undefined) {
              return organization.settings;
            }
            const routes = { ...orgAutoModel.routes };
            delete routes[mode_slug];
            return {
              ...organization.settings,
              org_auto_model: {
                ...orgAutoModel,
                routes,
              },
            };
          },
          tx
        );
        if (removedRoute !== undefined) {
          await createAuditLog({
            action: 'organization.settings.change',
            actor_email: ctx.user.google_user_email,
            actor_id: ctx.user.id,
            actor_name: ctx.user.google_user_name,
            message: `Cleared Organization Auto route for mode "${mode_slug}" (was "${removedRoute}")`,
            organization_id: organizationId,
            tx,
          });
        }
        return settings;
      });

      return { settings: updatedSettings };
    }),

  setOrganizationAutoFallback: organizationBillingMutationProcedure
    .input(SetOrganizationAutoFallbackInputSchema)
    .output(SettingsResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId, model_id } = input;
      await assertOrganizationAutoWriteEnabled(ctx.user.id);

      const existingOrg = await getOrganizationById(organizationId);
      if (!existingOrg) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
      }
      assertOrganizationAutoEligible(existingOrg);

      let validatedModelId: string | undefined;
      let previousFallback: string | undefined;
      const updatedSettings = await db.transaction(async tx => {
        const settings = await mutateOrganizationSettings(
          organizationId,
          async organization => {
            assertOrganizationAutoEligible(organization);
            const validation = await validateOrganizationAutoTarget(organization, model_id, {
              dbClient: tx,
            });
            if (validation.kind === 'error') {
              throw new TRPCError({ code: 'BAD_REQUEST', message: validation.message });
            }
            validatedModelId = validation.modelId;
            const orgAutoModel =
              organization.settings.org_auto_model ?? DEFAULT_ORGANIZATION_AUTO_MODEL_SETTINGS;
            previousFallback = orgAutoModel.fallback_model;
            if (previousFallback === validation.modelId) {
              return organization.settings;
            }
            return {
              ...organization.settings,
              org_auto_model: {
                ...orgAutoModel,
                fallback_model: validation.modelId,
              },
            };
          },
          tx
        );
        if (previousFallback !== validatedModelId) {
          await createAuditLog({
            action: 'organization.settings.change',
            actor_email: ctx.user.google_user_email,
            actor_id: ctx.user.id,
            actor_name: ctx.user.google_user_name,
            message: `Updated Organization Auto fallback model: "${previousFallback}" → "${validatedModelId}"`,
            organization_id: organizationId,
            tx,
          });
        }
        return settings;
      });

      return { settings: updatedSettings };
    }),

  configureOrganizationDefaultBehavior: organizationBillingMutationProcedure
    .input(ConfigureOrganizationDefaultBehaviorInputSchema)
    .output(SettingsResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId, behavior, fallback_model, specific_model } = input;
      if (behavior === 'auto') {
        await assertOrganizationAutoWriteEnabled(ctx.user.id);
      }

      const existingOrg = await getOrganizationById(organizationId);
      if (!existingOrg) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
      }
      assertOrganizationAutoEligible(existingOrg);

      let previousDefaultModel: string | undefined;
      let didChange = false;
      const updatedSettings = await db.transaction(async tx => {
        const settings = await mutateOrganizationSettings(
          organizationId,
          async organization => {
            previousDefaultModel = organization.settings.default_model;
            const returnChangedSettings = (nextSettings: typeof organization.settings) => {
              if (
                organization.settings.default_model === nextSettings.default_model &&
                JSON.stringify(organization.settings.org_auto_model) ===
                  JSON.stringify(nextSettings.org_auto_model)
              ) {
                return organization.settings;
              }
              didChange = true;
              return nextSettings;
            };
            assertOrganizationAutoEligible(organization);
            if (behavior === 'global') {
              return returnChangedSettings({ ...organization.settings, default_model: undefined });
            }

            if (behavior === 'specific') {
              if (!specific_model) {
                throw new TRPCError({
                  code: 'BAD_REQUEST',
                  message: 'Specific model is required.',
                });
              }
              const modelId =
                organization.settings.default_model === ORG_AUTO_MODEL.id
                  ? await validateOrganizationDefaultReplacement(organization, specific_model)
                  : await validateOrganizationDefaultModel(organization, specific_model);
              return returnChangedSettings({ ...organization.settings, default_model: modelId });
            }

            const orgAutoModel =
              organization.settings.org_auto_model ?? DEFAULT_ORGANIZATION_AUTO_MODEL_SETTINGS;
            const isEnablingOrganizationAuto =
              organization.settings.default_model !== ORG_AUTO_MODEL.id;
            const routes = { ...orgAutoModel.routes };

            if (isEnablingOrganizationAuto) {
              assertOrganizationAutoRouteCount(routes);
              for (const [slug, targetModelId] of Object.entries(routes)) {
                const routeValidation = await validateOrganizationAutoTarget(
                  organization,
                  targetModelId,
                  { dbClient: tx }
                );
                if (routeValidation.kind === 'error') {
                  throw new TRPCError({
                    code: 'BAD_REQUEST',
                    message: `Cannot enable Organization Auto because route "${slug}" is invalid: ${routeValidation.message}`,
                  });
                }
                routes[slug] = routeValidation.modelId;
              }
            }

            const requestedFallback = fallback_model ?? orgAutoModel.fallback_model;
            const validation = await validateOrganizationAutoTarget(
              organization,
              requestedFallback,
              {
                dbClient: tx,
              }
            );
            if (validation.kind === 'error') {
              throw new TRPCError({ code: 'BAD_REQUEST', message: validation.message });
            }
            return returnChangedSettings({
              ...organization.settings,
              default_model: ORG_AUTO_MODEL.id,
              org_auto_model: {
                ...orgAutoModel,
                routes,
                fallback_model: validation.modelId,
              },
            });
          },
          tx
        );
        if (didChange) {
          await createAuditLog({
            action: 'organization.settings.change',
            actor_email: ctx.user.google_user_email,
            actor_id: ctx.user.id,
            actor_name: ctx.user.google_user_name,
            message:
              behavior === 'auto'
                ? 'Configured Organization Auto default behavior.'
                : behavior === 'specific'
                  ? `Configured specific organization default model: ${settings.default_model}`
                  : previousDefaultModel === ORG_AUTO_MODEL.id
                    ? 'Disabled Organization Auto and reset organization default model to global default.'
                    : 'Reset organization default model to global default.',
            organization_id: organizationId,
            tx,
          });
        }
        return settings;
      });

      return { settings: updatedSettings };
    }),

  updateDataCollection: organizationBillingMutationProcedure
    .input(UpdateDataCollectionInputSchema)
    .output(SettingsResponseSchema)
    .mutation(async ({ input }) => {
      const { organizationId, dataCollection } = input;

      const existingOrg = await getOrganizationById(organizationId);
      if (!existingOrg) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      const updatedSettings = await db.transaction(async tx =>
        mutateOrganizationSettings(
          organizationId,
          organization => ({
            ...organization.settings,
            data_collection: dataCollection,
          }),
          tx
        )
      );

      return {
        settings: updatedSettings,
      };
    }),

  updateProjectsUIEnabled: organizationBillingMutationProcedure
    .input(UpdateProjectsUIEnabledInputSchema)
    .output(SettingsResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId, projects_ui_enabled } = input;

      // Check if organization is in the privileged list
      if (
        !PRIVILEGED_ORGANIZATION_IDS.includes(
          organizationId as (typeof PRIVILEGED_ORGANIZATION_IDS)[number]
        )
      ) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'This organization is not authorized to modify experimental features',
        });
      }

      const existingOrg = await getOrganizationById(organizationId);
      if (!existingOrg) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      let previousSettings: OrganizationSettings | undefined;
      const updatedSettings = await db.transaction(async tx => {
        const settings = await mutateOrganizationSettings(
          organizationId,
          organization => {
            previousSettings = organization.settings;
            return {
              ...organization.settings,
              projects_ui_enabled,
            };
          },
          tx
        );

        if (previousSettings?.projects_ui_enabled !== projects_ui_enabled) {
          await createAuditLog({
            action: 'organization.settings.change',
            actor_email: ctx.user.google_user_email,
            actor_id: ctx.user.id,
            actor_name: ctx.user.google_user_name,
            message: `Projects UI: ${projects_ui_enabled ? 'enabled' : 'disabled'}`,
            organization_id: organizationId,
            tx,
          });
        }

        return settings;
      });

      return {
        settings: updatedSettings,
      };
    }),

  updateCodeIndexingFeatureFlag: adminProcedure
    .input(UpdateCodeIndexingEnabledInputSchema)
    .output(SettingsResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId, code_indexing_enabled } = input;

      const existingOrg = await getOrganizationById(organizationId);
      if (!existingOrg) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      let previousSettings: OrganizationSettings | undefined;
      const updatedSettings = await db.transaction(async tx => {
        const settings = await mutateOrganizationSettings(
          organizationId,
          organization => {
            previousSettings = organization.settings;
            return {
              ...organization.settings,
              code_indexing_enabled,
            };
          },
          tx
        );

        if (previousSettings?.code_indexing_enabled !== code_indexing_enabled) {
          await createAuditLog({
            action: 'organization.settings.change',
            actor_email: ctx.user.google_user_email,
            actor_id: ctx.user.id,
            actor_name: ctx.user.google_user_name,
            message: `[Admin] Code indexing: ${code_indexing_enabled ? 'enabled' : 'disabled'}`,
            organization_id: organizationId,
            tx,
          });
        }

        return settings;
      });

      return {
        settings: updatedSettings,
      };
    }),

  updateMinimumBalanceAlert: organizationBillingMutationProcedure
    .input(UpdateMinimumBalanceAlertInputSchema)
    .output(SettingsResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId, enabled, minimum_balance, minimum_balance_alert_email } = input;

      const existingOrg = await getOrganizationById(organizationId);
      if (!existingOrg) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      let previousSettings: OrganizationSettings | undefined;
      const updatedSettings = await db.transaction(async tx => {
        const settings = await mutateOrganizationSettings(
          organizationId,
          organization => {
            previousSettings = organization.settings;
            if (enabled) {
              return {
                ...organization.settings,
                minimum_balance,
                minimum_balance_alert_email,
              };
            }

            const settings = { ...organization.settings };
            delete settings.minimum_balance;
            delete settings.minimum_balance_alert_email;
            return settings;
          },
          tx
        );

        const wasEnabled =
          previousSettings?.minimum_balance !== undefined &&
          previousSettings?.minimum_balance_alert_email !== undefined;
        if (enabled !== wasEnabled || enabled) {
          await createAuditLog({
            action: 'organization.settings.change',
            actor_email: ctx.user.google_user_email,
            actor_id: ctx.user.id,
            actor_name: ctx.user.google_user_name,
            message: enabled
              ? `Minimum balance alert: enabled (threshold: $${minimum_balance}, emails: ${minimum_balance_alert_email?.join(', ')})`
              : 'Minimum balance alert: disabled',
            organization_id: organizationId,
            tx,
          });
        }

        return settings;
      });

      return {
        settings: updatedSettings,
      };
    }),
});
