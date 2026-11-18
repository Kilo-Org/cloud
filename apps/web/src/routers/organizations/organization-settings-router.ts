import {
  getOrganizationById,
  mutateOrganizationSettings,
  setOrganizationRecommendationsDigestEnabled,
} from '@kilocode/web-shared/lib/organizations/organizations';
import type {
  OrganizationPlan,
  OrganizationSettings,
} from '@kilocode/web-shared/lib/organizations/organization-types';
import { createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import {
  OrganizationIdInputSchema,
  organizationBillingMutationProcedure,
  organizationAdminMutationProcedure,
  organizationMemberProcedure,
} from '@kilocode/web-shared/routers/organizations/utils';
import { listAvailableModelsProcedure } from '@kilocode/web-shared/routers/organizations/organization-available-models-procedure';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import type { OrganizationAuditLogDetails } from '@kilocode/db/schema-types';
import { createAuditLog } from '@kilocode/web-shared/lib/organizations/organization-audit-logs';
import { KILO_ORGANIZATION_ID } from '@kilocode/web-shared/lib/organizations/constants';
import { createAllowPredicateFromRestrictions } from '@kilocode/web-shared/lib/model-allow.server';
import { getAvailableModelsForOrganization } from '@kilocode/web-shared/lib/organizations/organization-models';
import { bumpOrganizationGroupPolicyRevision } from '@kilocode/web-shared/lib/organizations/organization-groups';
import { getEffectiveModelRestrictions } from '@/lib/organizations/model-restrictions';
import { normalizeModelId } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import {
  MAX_ORGANIZATION_BROWSER_ALLOWED_ORIGINS,
  OrganizationBrowserAllowedOriginSchema,
  OrganizationBrowserControlSchema,
  OrganizationDataRegionSchema,
  normalizeOrganizationBrowserOrigin,
} from '@kilocode/db/schema-types';
import {
  resolveOrganizationBrowserPolicy,
  type OrganizationBrowserPolicy,
} from '@/lib/organizations/browser-policy';
import {
  isOrganizationFeatureEnabled,
  readOrganizationFeatures,
} from '@kilocode/web-shared/lib/ai-gateway/organization-features';
import { ORGANIZATION_DATA_REGION_NAMES } from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import { ORG_AUTO_MODEL } from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import { getModelGateways } from '@kilocode/web-shared/lib/ai-gateway/providers/model-gateway-availability';
import {
  DEFAULT_ORGANIZATION_AUTO_MODEL_SETTINGS,
  MAX_ORGANIZATION_AUTO_ROUTES,
  assertOrganizationAutoEligible,
  assertOrganizationAutoWriteEnabled,
  validateOrganizationAutoTarget,
} from '@kilocode/web-shared/lib/organizations/organization-auto-model';

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
 * The same facts `createAccessListsDiffMessage` summarizes, as the audit row's structured
 * details: what each list gained or lost. Empty when a list was never set or nothing changed.
 */
function createAccessListsDetails(
  oldSettings: OrganizationSettings | undefined,
  newSettings: OrganizationSettings
): OrganizationAuditLogDetails {
  const old = oldSettings || {};
  const listChanged = <T>(a: readonly T[] | undefined, b: readonly T[] | undefined) =>
    a !== b && JSON.stringify(a ?? []) !== JSON.stringify(b ?? []);
  const added = <T>(before: readonly T[] | undefined, after: readonly T[] | undefined) => {
    const oldSet = new Set((before || []) as T[]);
    return ((after || []) as T[]).filter(item => !oldSet.has(item));
  };
  const removed = <T>(before: readonly T[] | undefined, after: readonly T[] | undefined) =>
    added(after, before);

  const deniedModelsChanged = listChanged(old.model_deny_list, newSettings.model_deny_list);
  const providersChanged = listChanged(old.provider_allow_list, newSettings.provider_allow_list);
  return {
    kind: 'access_lists_changed',
    ...(deniedModelsChanged
      ? {
          deniedModels: added(old.model_deny_list, newSettings.model_deny_list),
          allowedModels: removed(old.model_deny_list, newSettings.model_deny_list),
        }
      : {}),
    ...(providersChanged
      ? {
          allowedProviders: added(old.provider_allow_list, newSettings.provider_allow_list),
          disallowedProviders: removed(old.provider_allow_list, newSettings.provider_allow_list),
        }
      : {}),
  };
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

/**
 * Creates the audit message for a change to the organization data collection policy
 */
function createDataCollectionMessage(
  dataCollection: OrganizationSettings['data_collection']
): string {
  if (dataCollection === 'allow') {
    return 'Data collection: allowed';
  }
  if (dataCollection === 'deny') {
    return 'Data collection: denied';
  }
  return 'Data collection: follow extension setting';
}

function assertOrganizationAutoRouteCount(routes: Record<string, string>): void {
  if (Object.keys(routes).length > MAX_ORGANIZATION_AUTO_ROUTES) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Organization Auto supports at most ${MAX_ORGANIZATION_AUTO_ROUTES} routes`,
    });
  }
}

async function assertActiveOrganizationAutoTargetsAllowed(
  organization: Pick<NonNullable<Awaited<ReturnType<typeof getOrganizationById>>>, 'id' | 'plan'>,
  settings: OrganizationSettings,
  dbClient: typeof db | DrizzleTransaction
): Promise<void> {
  if (settings.default_model !== ORG_AUTO_MODEL.id || !settings.org_auto_model) {
    return;
  }

  assertOrganizationAutoRouteCount(settings.org_auto_model.routes);
  const validationOrganization = {
    id: organization.id,
    plan: organization.plan,
    settings,
  };

  for (const [slug, targetModelId] of Object.entries(settings.org_auto_model.routes)) {
    const validation = await validateOrganizationAutoTarget(validationOrganization, targetModelId, {
      dbClient,
    });
    if (validation.kind === 'error') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Cannot update model policy because active Organization Auto route "${slug}" is invalid: ${validation.message}`,
      });
    }
  }

  const fallbackValidation = await validateOrganizationAutoTarget(
    validationOrganization,
    settings.org_auto_model.fallback_model,
    { dbClient }
  );
  if (fallbackValidation.kind === 'error') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Cannot update model policy because active Organization Auto fallback is invalid: ${fallbackValidation.message}`,
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
      message: 'Configure Organization Auto through the default model behavior flow.',
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
    availableModels = await getAvailableModelsForOrganization(
      organization.id,
      { type: 'defaultAccess' },
      'member',
      { countryCode: null }
    );
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

const ConfigureOrganizationDefaultBehaviorInputSchema = OrganizationIdInputSchema.extend({
  behavior: z.enum(['auto', 'specific', 'global']),
  fallback_model: z.string().min(1).max(200).optional(),
  specific_model: z.string().min(1).max(200).optional(),
});

const UpdateDataCollectionInputSchema = OrganizationIdInputSchema.extend({
  dataCollection: z.enum(['allow', 'deny']).nullable(),
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

const UpdateRecommendationsDigestInputSchema = OrganizationIdInputSchema.extend({
  // The digest is a simple on/off toggle; when on it emails the org's owners.
  enabled: z.boolean(),
});

const SettingsResponseSchema = z.object({
  settings: z.custom<OrganizationSettings>(),
});

const UpdateBrowserControlInputSchema = OrganizationIdInputSchema.extend({
  browserControl: OrganizationBrowserControlSchema,
  browserAllowedOrigins: z
    .array(OrganizationBrowserAllowedOriginSchema)
    .max(MAX_ORGANIZATION_BROWSER_ALLOWED_ORIGINS),
});

const BrowserControlResponseSchema = z.object({
  browserControl: OrganizationBrowserControlSchema,
  browserAllowedOrigins: z.array(OrganizationBrowserAllowedOriginSchema),
});

function normalizeBrowserOrigins(values: readonly string[]): string[] {
  const origins = new Set<string>();
  for (const value of values) {
    const origin = normalizeOrganizationBrowserOrigin(value);
    if (origin !== null) {
      origins.add(origin);
    }
  }
  return [...origins];
}

function createBrowserControlMessage(policy: OrganizationBrowserPolicy): string {
  const origins =
    policy.browserAllowedOrigins.length > 0 ? policy.browserAllowedOrigins.join(', ') : 'none';
  return `Browser control: ${policy.browserControl} (allowed origins: ${origins})`;
}

const UpdateGatewaySettingsInputSchema = OrganizationIdInputSchema.extend({
  disable_openrouter: z.boolean().optional(),
  data_region: OrganizationDataRegionSchema.nullable().optional(),
});

const GatewaySettingsResponseSchema = z.object({
  available: z.boolean(),
  disable_openrouter: z.boolean(),
  data_region: OrganizationDataRegionSchema.nullable(),
});

const ModelGatewayAvailabilityResponseSchema = z.object({
  gateways: z.array(z.enum(['vercel', 'openrouter'])),
});

/**
 * The advanced gateway policies are an enterprise feature, rolled out per organization through the
 * `gateway_settings` organization feature. The gateway ignores them on any other plan.
 */
async function isGatewaySettingsAvailable(organizationId: string, plan: OrganizationPlan) {
  if (plan !== 'enterprise') return false;
  return isOrganizationFeatureEnabled(
    await readOrganizationFeatures(db),
    'gateway_settings',
    organizationId
  );
}

function createGatewaySettingsDiffMessage(
  oldSettings: OrganizationSettings,
  newSettings: OrganizationSettings
): string {
  const changes: string[] = [];
  if (!!oldSettings.disable_openrouter !== !!newSettings.disable_openrouter) {
    changes.push(`OpenRouter ${newSettings.disable_openrouter ? 'disabled' : 'enabled'}`);
  }
  if ((oldSettings.data_region ?? null) !== (newSettings.data_region ?? null)) {
    changes.push(
      `Inference region: ${newSettings.data_region ? ORGANIZATION_DATA_REGION_NAMES[newSettings.data_region] : 'Global'}`
    );
  }
  return changes.length > 0
    ? `Updated advanced policies: ${changes.join('; ')}`
    : 'Updated advanced policies: no changes';
}

export const organizationsSettingsRouter = createTRPCRouter({
  listAvailableModels: listAvailableModelsProcedure,

  getGatewaySettings: organizationMemberProcedure
    .output(GatewaySettingsResponseSchema)
    .query(async ({ input }) => {
      const organization = await getOrganizationById(input.organizationId);
      if (!organization) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
      }
      return {
        available: await isGatewaySettingsAvailable(input.organizationId, organization.plan),
        disable_openrouter: organization.settings.disable_openrouter ?? false,
        data_region: organization.settings.data_region ?? null,
      };
    }),

  getModelGatewayAvailability: organizationMemberProcedure
    .input(OrganizationIdInputSchema.extend({ modelId: z.string().min(1) }))
    .output(ModelGatewayAvailabilityResponseSchema)
    .query(async ({ input }) => {
      const organization = await getOrganizationById(input.organizationId);
      if (!organization) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
      }
      if (!(await isGatewaySettingsAvailable(input.organizationId, organization.plan))) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Advanced policies are not available for this organization.',
        });
      }
      return { gateways: await getModelGateways(input.modelId) };
    }),

  updateGatewaySettings: organizationAdminMutationProcedure
    .input(UpdateGatewaySettingsInputSchema)
    .output(SettingsResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId, disable_openrouter, data_region } = input;
      const organization = await getOrganizationById(organizationId);
      if (!organization) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
      }
      if (!(await isGatewaySettingsAvailable(organizationId, organization.plan))) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Advanced policies are not available for this organization.',
        });
      }

      const updatedSettings = await db.transaction(async tx => {
        let previousSettings: OrganizationSettings = {};
        const settings = await mutateOrganizationSettings(
          organizationId,
          async organization => {
            previousSettings = organization.settings;
            const settingsUpdate: OrganizationSettings = { ...organization.settings };
            if (disable_openrouter !== undefined) {
              settingsUpdate.disable_openrouter = disable_openrouter;
            }
            if (data_region !== undefined) {
              settingsUpdate.data_region = data_region;
            }
            return settingsUpdate;
          },
          tx
        );
        const openRouterDisabledChanged =
          !!previousSettings.disable_openrouter !== !!settings.disable_openrouter;
        const regionChanged =
          (previousSettings.data_region ?? null) !== (settings.data_region ?? null);
        await createAuditLog({
          action: 'organization.settings.change',
          actor_email: ctx.user.google_user_email,
          actor_id: ctx.user.id,
          actor_name: ctx.user.google_user_name,
          message: createGatewaySettingsDiffMessage(previousSettings, settings),
          details: {
            kind: 'gateway_settings_changed',
            changed: openRouterDisabledChanged || regionChanged,
            ...(openRouterDisabledChanged
              ? { openRouterDisabled: !!settings.disable_openrouter }
              : {}),
            ...(regionChanged ? { region: settings.data_region ?? null } : {}),
          },
          organization_id: organizationId,
          tx,
        });
        return settings;
      });
      return { settings: updatedSettings };
    }),

  updateAllowLists: organizationAdminMutationProcedure
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
        await bumpOrganizationGroupPolicyRevision(tx, organizationId, ctx.user.id);
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
                requireModelInCurrentSnapshot: true,
                providerAllowList: settingsUpdate.provider_allow_list,
                modelDenyList: settingsUpdate.model_deny_list ?? [],
                customLlmGrantee: { organizationId: organization.id, groupIds: [] },
              });
              if (!(await isAllowed(currentSettings.default_model))) {
                settingsUpdate.default_model = undefined;
              }
            }
            await assertActiveOrganizationAutoTargetsAllowed(organization, settingsUpdate, tx);
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
          details: createAccessListsDetails(previousSettings, settings),
          organization_id: organizationId,
          tx,
        });
        return settings;
      });
      return { settings: updatedSettings };
    }),

  updateDefaultModel: organizationAdminMutationProcedure
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
          message: 'Configure Organization Auto through the default model behavior flow.',
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
                message: 'Configure Organization Auto through the default model behavior flow.',
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
          details: {
            kind: 'default_model_changed',
            verb:
              previousSettings?.default_model === settings.default_model
                ? 'no_change'
                : previousSettings?.default_model && settings.default_model
                  ? 'changed'
                  : settings.default_model
                    ? 'set'
                    : 'removed',
            ...(previousSettings?.default_model
              ? { oldModel: previousSettings.default_model }
              : {}),
            ...(settings.default_model ? { newModel: settings.default_model } : {}),
          },
          organization_id: organizationId,
          tx,
        });
        return settings;
      });
      return { settings: updatedSettings };
    }),

  setOrganizationAutoRoute: organizationAdminMutationProcedure
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
            details: {
              kind: 'auto_route_set',
              modeSlug: mode_slug,
              previousRoute: previousRoute ?? null,
              newRoute: validatedModelId as string,
            },
            organization_id: organizationId,
            tx,
          });
        }
        return settings;
      });

      return { settings: updatedSettings };
    }),

  clearOrganizationAutoRoute: organizationAdminMutationProcedure
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
            details: {
              kind: 'auto_route_cleared',
              modeSlug: mode_slug,
              previousRoute: removedRoute,
            },
            organization_id: organizationId,
            tx,
          });
        }
        return settings;
      });

      return { settings: updatedSettings };
    }),

  configureOrganizationDefaultBehavior: organizationAdminMutationProcedure
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
            details: {
              kind: 'default_behavior_changed',
              behavior:
                behavior === 'auto'
                  ? 'organization_auto'
                  : behavior === 'specific'
                    ? 'specific_model'
                    : previousDefaultModel === ORG_AUTO_MODEL.id
                      ? 'disabled_auto'
                      : 'reset_to_global',
              ...(behavior === 'specific' && settings.default_model
                ? { model: settings.default_model }
                : {}),
            },
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
    .mutation(async ({ input, ctx }) => {
      const { organizationId, dataCollection } = input;

      const existingOrg = await getOrganizationById(organizationId);
      if (!existingOrg) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      const updatedSettings = await db.transaction(async tx => {
        let previousDataCollection: OrganizationSettings['data_collection'];
        const settings = await mutateOrganizationSettings(
          organizationId,
          organization => {
            previousDataCollection = organization.settings?.data_collection ?? null;
            return { ...organization.settings, data_collection: dataCollection };
          },
          tx
        );
        // An unset value and an explicit null both follow the extension setting.
        if ((dataCollection ?? null) !== previousDataCollection) {
          await createAuditLog({
            action: 'organization.settings.change',
            actor_email: ctx.user.google_user_email,
            actor_id: ctx.user.id,
            actor_name: ctx.user.google_user_name,
            message: createDataCollectionMessage(dataCollection),
            details: {
              kind: 'data_collection_changed',
              value:
                dataCollection === 'allow'
                  ? 'allowed'
                  : dataCollection === 'deny'
                    ? 'denied'
                    : 'follow_extension_setting',
            },
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

      const updatedSettings = await db.transaction(async tx => {
        let previousValue: boolean | undefined;
        const settings = await mutateOrganizationSettings(
          organizationId,
          organization => {
            previousValue = organization.settings?.projects_ui_enabled;
            return { ...organization.settings, projects_ui_enabled };
          },
          tx
        );

        if (previousValue !== projects_ui_enabled) {
          await createAuditLog({
            action: 'organization.settings.change',
            actor_email: ctx.user.google_user_email,
            actor_id: ctx.user.id,
            actor_name: ctx.user.google_user_name,
            message: `Projects UI: ${projects_ui_enabled ? 'enabled' : 'disabled'}`,
            details: { kind: 'projects_ui_changed', enabled: projects_ui_enabled },
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

      const updatedSettings = await db.transaction(async tx => {
        let previousSettings: OrganizationSettings = {};
        const settings = await mutateOrganizationSettings(
          organizationId,
          organization => {
            previousSettings = organization.settings || {};
            if (!enabled) {
              // Remove the fields when disabled
              const {
                minimum_balance: _mb,
                minimum_balance_alert_email: _mbae,
                ...rest
              } = previousSettings;
              return rest;
            }
            return {
              ...previousSettings,
              minimum_balance,
              minimum_balance_alert_email,
            };
          },
          tx
        );

        const wasEnabled =
          previousSettings.minimum_balance !== undefined &&
          previousSettings.minimum_balance_alert_email !== undefined;
        if (enabled !== wasEnabled || enabled) {
          await createAuditLog({
            action: 'organization.settings.change',
            actor_email: ctx.user.google_user_email,
            actor_id: ctx.user.id,
            actor_name: ctx.user.google_user_name,
            message: enabled
              ? `Minimum balance alert: enabled (threshold: $${minimum_balance}, emails: ${minimum_balance_alert_email?.join(', ')})`
              : 'Minimum balance alert: disabled',
            details: {
              kind: 'minimum_balance_alert_changed',
              enabled,
              ...(enabled && minimum_balance !== undefined
                ? { thresholdCents: Math.round(minimum_balance * 100) }
                : {}),
              ...(enabled && minimum_balance_alert_email
                ? { alertEmails: minimum_balance_alert_email }
                : {}),
            },
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

  // Owners-only: toggle the weekly enterprise recommendations digest email.
  // Enterprise-gated and owner-only (matching the recommendations dismiss/restore
  // permission model). When on, the digest is emailed to the org's owners.
  updateRecommendationsDigest: organizationAdminMutationProcedure
    .input(UpdateRecommendationsDigestInputSchema)
    .output(SettingsResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId, enabled } = input;

      const existingOrg = await getOrganizationById(organizationId);
      if (!existingOrg) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      // Enterprise-only feature.
      if (existingOrg.plan !== 'enterprise') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'The recommendations digest is not available for this organization.',
        });
      }

      const wasEnabled = existingOrg.settings?.recommendations_digest_enabled === true;

      // Atomic single-key JSONB update so a concurrent settings mutation can't be
      // clobbered by a stale read-modify-write of the whole settings object.
      const updatedSettings = await setOrganizationRecommendationsDigestEnabled(
        organizationId,
        enabled
      );

      if (enabled !== wasEnabled) {
        await createAuditLog({
          action: 'organization.settings.change',
          actor_email: ctx.user.google_user_email,
          actor_id: ctx.user.id,
          actor_name: ctx.user.google_user_name,
          message: enabled ? 'Recommendations digest: enabled' : 'Recommendations digest: disabled',
          details: { kind: 'recommendations_digest_changed', enabled },
          organization_id: organizationId,
        });
      }

      return {
        settings: updatedSettings,
      };
    }),

  // Browser automation policy: owners and admins decide whether members get browser
  // tools, whether the bundled browser is the only backend, and which origins every
  // member's client treats as already granted.
  updateBrowserControl: organizationAdminMutationProcedure
    .input(UpdateBrowserControlInputSchema)
    .output(BrowserControlResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId, browserControl, browserAllowedOrigins } = input;

      const existingOrg = await getOrganizationById(organizationId);
      if (!existingOrg) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
      }

      const nextPolicy: OrganizationBrowserPolicy = {
        browserControl,
        browserAllowedOrigins: normalizeBrowserOrigins(browserAllowedOrigins),
      };

      const updatedSettings = await db.transaction(async tx => {
        let previousPolicy = resolveOrganizationBrowserPolicy(existingOrg);
        const settings = await mutateOrganizationSettings(
          organizationId,
          organization => {
            previousPolicy = resolveOrganizationBrowserPolicy(organization);
            if (
              previousPolicy.browserControl === nextPolicy.browserControl &&
              previousPolicy.browserAllowedOrigins.join('\n') ===
                nextPolicy.browserAllowedOrigins.join('\n')
            ) {
              return organization.settings;
            }
            return {
              ...organization.settings,
              browserControl: nextPolicy.browserControl,
              browserAllowedOrigins: nextPolicy.browserAllowedOrigins,
            };
          },
          tx
        );

        if (
          previousPolicy.browserControl !== nextPolicy.browserControl ||
          previousPolicy.browserAllowedOrigins.join('\n') !==
            nextPolicy.browserAllowedOrigins.join('\n')
        ) {
          await createAuditLog({
            action: 'organization.settings.change',
            actor_email: ctx.user.google_user_email,
            actor_id: ctx.user.id,
            actor_name: ctx.user.google_user_name,
            message: createBrowserControlMessage(nextPolicy),
            details: {
              kind: 'browser_control_changed',
              mode: nextPolicy.browserControl,
              origins: nextPolicy.browserAllowedOrigins,
            },
            organization_id: organizationId,
            tx,
          });
        }

        return settings;
      });

      return resolveOrganizationBrowserPolicy({ settings: updatedSettings });
    }),
});
