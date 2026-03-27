import { getOrganizationById, updateOrganizationSettings } from '@/lib/organizations/organizations';
import type { OrganizationSettings } from '@/lib/organizations/organization-types';
import type {
  OpenRouterModel,
  OpenRouterModelsResponse,
} from '@/lib/organizations/organization-types';
import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  OrganizationIdInputSchema,
  organizationOwnerProcedure,
  organizationMemberProcedure,
} from '@/routers/organizations/utils';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { getEnhancedOpenRouterModels } from '@/lib/providers/openrouter';
import { requireActiveSubscriptionOrTrial } from '@/lib/organizations/trial-middleware';
import { createAllowPredicateFromDenyList } from '@/lib/model-allow.server';
import { KILO_ORGANIZATION_ID } from '@/lib/organizations/constants';
import { listAvailableCustomLlms } from '@/lib/custom-llm/listAvailableCustomLlms';
import { getCodingPlanModelsForOrganization } from '@/lib/providers/coding-plans';

/**
 * Allowlist of organization IDs that are allowed to modify experimental settings
 */
const PRIVILEGED_ORGANIZATION_IDS = [
  KILO_ORGANIZATION_ID, // production kilo code org
  '03366a2a-b498-498a-8560-98bffe4a0997', // john's local test org
] as const;

/**
 * Creates a human-readable diff message for deny list changes
 */
function createDenyListsDiffMessage(
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
      changes.push(`Added to model deny list: ${added.join(', ')}`);
    }
    if (removed.length > 0) {
      changes.push(`Removed from model deny list: ${removed.join(', ')}`);
    }
  }

  if (old.provider_deny_list !== newSettings.provider_deny_list) {
    const oldProviders = new Set(old.provider_deny_list || []);
    const newProviders = new Set(newSettings.provider_deny_list || []);

    const added = [...newProviders].filter(provider => !oldProviders.has(provider));
    const removed = [...oldProviders].filter(provider => !newProviders.has(provider));

    if (added.length > 0) {
      changes.push(`Added to provider deny list: ${added.join(', ')}`);
    }
    if (removed.length > 0) {
      changes.push(`Removed from provider deny list: ${removed.join(', ')}`);
    }
  }

  return changes.length > 0 ? changes.join('; ') : 'Updated deny lists';
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

const UpdateDenyListsInputSchema = OrganizationIdInputSchema.extend({
  model_deny_list: z.array(z.string()).optional(),
  provider_deny_list: z.array(z.string()).optional(),
});

const UpdateDefaultModelInputSchema = OrganizationIdInputSchema.extend({
  default_model: z.string().or(z.null()),
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

      const organization = await getOrganizationById(organizationId);
      if (!organization) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      let deniedModels: string[] | undefined;
      let deniedProviders: string[] | undefined;

      if (organization.plan === 'enterprise') {
        deniedModels = organization.settings?.model_deny_list;
        deniedProviders = organization.settings?.provider_deny_list;
      }

      const responseData = await getEnhancedOpenRouterModels();

      let filteredModels = responseData.data;
      if (deniedModels?.length || deniedProviders?.length) {
        const isAllowed = createAllowPredicateFromDenyList(deniedModels, deniedProviders);
        const models: OpenRouterModel[] = [];
        for (const model of responseData.data) {
          if (await isAllowed(model.id)) {
            models.push(model);
          }
        }
        filteredModels = models;
      }

      filteredModels.push(...(await getCodingPlanModelsForOrganization(organizationId)));
      filteredModels.push(...(await listAvailableCustomLlms(organizationId)));

      return {
        ...responseData,
        data: filteredModels,
      };
    }),

  updateAllowLists: organizationOwnerProcedure
    .input(UpdateDenyListsInputSchema)
    .output(SettingsResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId, model_deny_list, provider_deny_list } = input;

      await requireActiveSubscriptionOrTrial(organizationId);

      const existingOrg = await getOrganizationById(organizationId);
      if (!existingOrg) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      // enterprise only feature
      if (existingOrg.plan !== 'enterprise') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Model access configuration is not available for this organization.',
        });
      }

      // Merge with existing settings
      const currentSettings = existingOrg.settings || {};
      const settingsUpdate: OrganizationSettings = {
        ...currentSettings,
      };

      if (model_deny_list !== undefined) {
        settingsUpdate.model_deny_list = [...new Set(model_deny_list)]; // Deduplicate slugs
      }
      if (provider_deny_list !== undefined) {
        settingsUpdate.provider_deny_list = [...new Set(provider_deny_list)]; // Deduplicate slugs
      }

      // Check if default_model needs to be cleared when deny lists change
      if (
        (model_deny_list !== undefined || provider_deny_list !== undefined) &&
        currentSettings.default_model
      ) {
        const effectiveModelDenyList = settingsUpdate.model_deny_list ?? [];
        const effectiveProviderDenyList = settingsUpdate.provider_deny_list ?? [];
        if (effectiveModelDenyList.length > 0 || effectiveProviderDenyList.length > 0) {
          const isAllowed = createAllowPredicateFromDenyList(
            effectiveModelDenyList,
            effectiveProviderDenyList
          );

          if (!(await isAllowed(currentSettings.default_model))) {
            // Clear default_model if it's no longer allowed
            settingsUpdate.default_model = undefined;
          }
        }
      }

      const updatedSettings = await updateOrganizationSettings(organizationId, settingsUpdate);

      await createAuditLog({
        action: 'organization.settings.change',
        actor_email: ctx.user.google_user_email,
        actor_id: ctx.user.id,
        actor_name: ctx.user.google_user_name,
        message: createDenyListsDiffMessage(existingOrg.settings, updatedSettings),
        organization_id: organizationId,
      });

      return {
        settings: updatedSettings,
      };
    }),

  updateDefaultModel: organizationOwnerProcedure
    .input(UpdateDefaultModelInputSchema)
    .output(SettingsResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId, default_model } = input;

      await requireActiveSubscriptionOrTrial(organizationId);

      const existingOrg = await getOrganizationById(organizationId);
      if (!existingOrg) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      // enterprise only feature
      if (existingOrg.plan !== 'enterprise') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Model access configuration is not available for this organization.',
        });
      }

      // Validate default_model against existing model_deny_list and provider_deny_list
      const existingDeniedModels = existingOrg.settings?.model_deny_list;
      const existingDeniedProviders = existingOrg.settings?.provider_deny_list;
      if (
        (existingDeniedModels && existingDeniedModels.length > 0) ||
        (existingDeniedProviders && existingDeniedProviders.length > 0)
      ) {
        const isAllowed = createAllowPredicateFromDenyList(
          existingDeniedModels,
          existingDeniedProviders
        );

        if (default_model && !(await isAllowed(default_model))) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Default model '${default_model}' is not in the organization's allowed models list`,
          });
        }
      }

      // Merge with existing settings
      const currentSettings = existingOrg.settings || {};
      const updatedSettings = await updateOrganizationSettings(organizationId, {
        ...currentSettings,
        default_model: default_model ? default_model : undefined,
      });

      await createAuditLog({
        action: 'organization.settings.change',
        actor_email: ctx.user.google_user_email,
        actor_id: ctx.user.id,
        actor_name: ctx.user.google_user_name,
        message: createDefaultModelDiffMessage(existingOrg.settings, updatedSettings),
        organization_id: organizationId,
      });

      return {
        settings: updatedSettings,
      };
    }),

  updateDataCollection: organizationOwnerProcedure
    .input(UpdateDataCollectionInputSchema)
    .output(SettingsResponseSchema)
    .mutation(async ({ input }) => {
      const { organizationId, dataCollection } = input;

      await requireActiveSubscriptionOrTrial(organizationId);

      const existingOrg = await getOrganizationById(organizationId);
      if (!existingOrg) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      // Update the data collection setting
      const updatedSettings = await updateOrganizationSettings(organizationId, {
        ...existingOrg.settings,
        data_collection: dataCollection,
      });

      return {
        settings: updatedSettings,
      };
    }),

  updateProjectsUIEnabled: organizationOwnerProcedure
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

      // Merge with existing settings
      const currentSettings = existingOrg.settings || {};
      const updatedSettings = await updateOrganizationSettings(organizationId, {
        ...currentSettings,
        projects_ui_enabled,
      });

      // Create audit log if the value changed
      if (currentSettings.projects_ui_enabled !== projects_ui_enabled) {
        await createAuditLog({
          action: 'organization.settings.change',
          actor_email: ctx.user.google_user_email,
          actor_id: ctx.user.id,
          actor_name: ctx.user.google_user_name,
          message: `Projects UI: ${projects_ui_enabled ? 'enabled' : 'disabled'}`,
          organization_id: organizationId,
        });
      }

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

      // Merge with existing settings
      const currentSettings = existingOrg.settings || {};
      const updatedSettings = await updateOrganizationSettings(organizationId, {
        ...currentSettings,
        code_indexing_enabled,
      });

      // Create audit log if the value changed
      if (currentSettings.code_indexing_enabled !== code_indexing_enabled) {
        await createAuditLog({
          action: 'organization.settings.change',
          actor_email: ctx.user.google_user_email,
          actor_id: ctx.user.id,
          actor_name: ctx.user.google_user_name,
          message: `[Admin] Code indexing: ${code_indexing_enabled ? 'enabled' : 'disabled'}`,
          organization_id: organizationId,
        });
      }

      return {
        settings: updatedSettings,
      };
    }),

  updateMinimumBalanceAlert: organizationOwnerProcedure
    .input(UpdateMinimumBalanceAlertInputSchema)
    .output(SettingsResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId, enabled, minimum_balance, minimum_balance_alert_email } = input;

      await requireActiveSubscriptionOrTrial(organizationId);

      const existingOrg = await getOrganizationById(organizationId);
      if (!existingOrg) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      const currentSettings = existingOrg.settings || {};
      let updatedSettings: OrganizationSettings;

      if (enabled) {
        updatedSettings = await updateOrganizationSettings(organizationId, {
          ...currentSettings,
          minimum_balance,
          minimum_balance_alert_email,
        });
      } else {
        // Remove the fields when disabled
        const {
          minimum_balance: _mb,
          minimum_balance_alert_email: _mbae,
          ...rest
        } = currentSettings;
        updatedSettings = await updateOrganizationSettings(organizationId, rest);
      }

      // Create audit log
      const wasEnabled =
        currentSettings.minimum_balance !== undefined &&
        currentSettings.minimum_balance_alert_email !== undefined;
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
        });
      }

      return {
        settings: updatedSettings,
      };
    }),
});
