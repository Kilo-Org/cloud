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
import { createProviderAwareModelAllowPredicate } from '@/lib/model-allow.server';
import { KILO_ORGANIZATION_ID } from '@/lib/organizations/constants';

/**
 * Allowlist of organization IDs that are allowed to modify experimental settings
 */
const PRIVILEGED_ORGANIZATION_IDS = [
  KILO_ORGANIZATION_ID, // production kilo code org
  '03366a2a-b498-498a-8560-98bffe4a0997', // john's local test org
] as const;

/**
 * Creates a human-readable diff message for allow list changes
 */
function createAllowListsDiffMessage(
  oldSettings: OrganizationSettings | undefined,
  newSettings: OrganizationSettings
): string {
  const changes: string[] = [];
  const old = oldSettings || {};

  // Compare model_allow_list
  if (old.model_allow_list !== newSettings.model_allow_list) {
    const oldModels = new Set(old.model_allow_list || []);
    const newModels = new Set(newSettings.model_allow_list || []);

    const added = [...newModels].filter(model => !oldModels.has(model));
    const removed = [...oldModels].filter(model => !newModels.has(model));

    if (added.length > 0) {
      changes.push(`Added models: ${added.join(', ')}`);
    }
    if (removed.length > 0) {
      changes.push(`Removed models: ${removed.join(', ')}`);
    }
    if (added.length === 0 && removed.length === 0 && oldModels.size !== newModels.size) {
      changes.push(`Updated model allow list (${oldModels.size} → ${newModels.size} models)`);
    }
  }

  // Compare provider_allow_list
  if (old.provider_allow_list !== newSettings.provider_allow_list) {
    const oldProviders = new Set(old.provider_allow_list || []);
    const newProviders = new Set(newSettings.provider_allow_list || []);

    const added = [...newProviders].filter(provider => !oldProviders.has(provider));
    const removed = [...oldProviders].filter(provider => !newProviders.has(provider));

    if (added.length > 0) {
      changes.push(`Added providers: ${added.join(', ')}`);
    }
    if (removed.length > 0) {
      changes.push(`Removed providers: ${removed.join(', ')}`);
    }
  }

  return changes.length > 0 ? changes.join('; ') : 'Updated allow lists';
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

const UpdateAllowListsInputSchema = OrganizationIdInputSchema.extend({
  model_allow_list: z.array(z.string()).optional(),
  provider_allow_list: z.array(z.string()).optional(),
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
    .input(OrganizationIdInputSchema.extend({ includeSlackbotOnly: z.boolean().optional() }))
    .output(z.custom<OpenRouterModelsResponse>())
    .query(async ({ input }) => {
      const { organizationId, includeSlackbotOnly } = input;

      const organization = await getOrganizationById(organizationId);
      if (!organization) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      let allowedModels: string[] | undefined;

      if (organization?.settings?.model_allow_list) {
        allowedModels = organization.settings.model_allow_list;
      }

      const responseData = await getEnhancedOpenRouterModels({ includeSlackbotOnly });

      let filteredModels = responseData.data;
      if (allowedModels) {
        const isAllowed = createProviderAwareModelAllowPredicate(allowedModels);
        const models: OpenRouterModel[] = [];
        for (const model of responseData.data) {
          if (await isAllowed(model.id)) {
            models.push(model);
          }
        }
        filteredModels = models;
      }

      return {
        ...responseData,
        data: filteredModels,
      };
    }),

  updateAllowLists: organizationOwnerProcedure
    .input(UpdateAllowListsInputSchema)
    .output(SettingsResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId, model_allow_list, provider_allow_list } = input;

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

      if (model_allow_list !== undefined) {
        settingsUpdate.model_allow_list = [...new Set(model_allow_list)]; // Deduplicate slugs
      }
      if (provider_allow_list !== undefined) {
        settingsUpdate.provider_allow_list = [...new Set(provider_allow_list)]; // Deduplicate slugs
      }

      // Check if default_model needs to be cleared
      if (
        model_allow_list !== undefined &&
        currentSettings.default_model &&
        model_allow_list.length > 0
      ) {
        const isAllowed = createProviderAwareModelAllowPredicate(model_allow_list);

        if (!(await isAllowed(currentSettings.default_model))) {
          // Clear default_model if it's no longer in the allow list
          settingsUpdate.default_model = undefined;
        }
      }

      const updatedSettings = await updateOrganizationSettings(organizationId, settingsUpdate);

      await createAuditLog({
        action: 'organization.settings.change',
        actor_email: ctx.user.google_user_email,
        actor_id: ctx.user.id,
        actor_name: ctx.user.google_user_name,
        message: createAllowListsDiffMessage(existingOrg.settings, updatedSettings),
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

      // Validate default_model against existing model_allow_list
      const existingAllowedModels = existingOrg.settings?.model_allow_list;
      if (existingAllowedModels && existingAllowedModels.length > 0) {
        const isAllowed = createProviderAwareModelAllowPredicate(existingAllowedModels);

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
