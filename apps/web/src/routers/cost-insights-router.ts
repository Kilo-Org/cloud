import { TRPCError } from '@trpc/server';
import * as z from 'zod';

import { db } from '@/lib/drizzle';
import { createTRPCRouter, baseProcedure } from '@/lib/trpc/init';
import {
  buildCostInsightsDashboardData,
  buildCostInsightsEventHistoryData,
  buildCostInsightsSettingsData,
} from '@/lib/cost-insights/presenter';
import {
  acknowledgeCostInsightAlert,
  clearCostInsightAlertState,
  clearCostInsightThresholdEpisode,
  createCostInsightEvent,
  dismissCostInsightSuggestion,
  ownerHasUnreviewedCostInsightAlert,
  updateCostInsightOwnerConfig,
} from '@/lib/cost-insights/repository';
import { evaluateCostInsightsForOwner } from '@/lib/cost-insights/evaluation';
import { parseSpendThresholdUsd } from '@/lib/cost-insights/policy';

const UpdateCostInsightsSettingsSchema = z.object({
  spendAlertsEnabled: z.boolean(),
  costSuggestionsEnabled: z.boolean(),
  spendThresholdUsd: z.string().nullable(),
});

const AcknowledgeCostInsightAlertSchema = z.object({
  alertKind: z.enum(['anomaly', 'threshold']),
});

const DismissCostInsightSuggestionSchema = z.object({
  suggestionId: z.uuid(),
});

function changedFields(
  previous: {
    spend_alerts_enabled: boolean;
    cost_suggestions_enabled: boolean;
    spend_threshold_microdollars: number | null;
  },
  current: {
    spend_alerts_enabled: boolean;
    cost_suggestions_enabled: boolean;
    spend_threshold_microdollars: number | null;
  }
) {
  const fields: Record<string, { old: unknown; new: unknown }> = {};
  if (previous.spend_alerts_enabled !== current.spend_alerts_enabled) {
    fields.spendAlertsEnabled = {
      old: previous.spend_alerts_enabled,
      new: current.spend_alerts_enabled,
    };
  }
  if (previous.cost_suggestions_enabled !== current.cost_suggestions_enabled) {
    fields.costSuggestionsEnabled = {
      old: previous.cost_suggestions_enabled,
      new: current.cost_suggestions_enabled,
    };
  }
  if (previous.spend_threshold_microdollars !== current.spend_threshold_microdollars) {
    fields.spendThresholdMicrodollars = {
      old: previous.spend_threshold_microdollars,
      new: current.spend_threshold_microdollars,
    };
  }
  return fields;
}

async function updateOwnerSettings(params: {
  owner: { type: 'user'; id: string } | { type: 'organization'; id: string };
  actorUserId: string;
  input: z.infer<typeof UpdateCostInsightsSettingsSchema>;
}) {
  let spendThresholdMicrodollars: number | null;
  try {
    spendThresholdMicrodollars = parseSpendThresholdUsd(params.input.spendThresholdUsd);
  } catch (error) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: error instanceof Error ? error.message : 'Invalid spend threshold.',
    });
  }

  const { previous, current } = await updateCostInsightOwnerConfig(db, params.owner, {
    spendAlertsEnabled: params.input.spendAlertsEnabled,
    costSuggestionsEnabled: params.input.costSuggestionsEnabled,
    spendThresholdMicrodollars,
  });

  const changes = changedFields(previous, current);
  const hasChanges = Object.keys(changes).length > 0;
  if (hasChanges && previous.spend_alerts_enabled && !current.spend_alerts_enabled) {
    await clearCostInsightAlertState(db, params.owner);
    await createCostInsightEvent(db, {
      owner: params.owner,
      eventType: 'disabled',
      actorUserId: params.actorUserId,
      title: 'Spend Alerts turned off',
      description: 'Spend Alerts were disabled. Cost evidence remains visible.',
      snapshot: {
        changedFields: changes,
        settings: {
          spendAlertsEnabled: current.spend_alerts_enabled,
          costSuggestionsEnabled: current.cost_suggestions_enabled,
          spendThresholdMicrodollars: current.spend_threshold_microdollars,
        },
      },
    });
  } else if (hasChanges && (previous.spend_alerts_enabled || current.spend_alerts_enabled)) {
    await createCostInsightEvent(db, {
      owner: params.owner,
      eventType: 'config_changed',
      actorUserId: params.actorUserId,
      title: 'Cost Insights settings changed',
      description: 'Spend Alert settings were updated.',
      snapshot: {
        changedFields: changes,
        settings: {
          spendAlertsEnabled: current.spend_alerts_enabled,
          costSuggestionsEnabled: current.cost_suggestions_enabled,
          spendThresholdMicrodollars: current.spend_threshold_microdollars,
        },
      },
    });
  }

  if (
    previous.spend_threshold_microdollars !== null &&
    current.spend_threshold_microdollars === null
  ) {
    await clearCostInsightThresholdEpisode(db, params.owner, null);
  }
  if (current.spend_alerts_enabled || current.cost_suggestions_enabled) {
    await evaluateCostInsightsForOwner(db, params.owner);
  }
  return { success: true };
}

export const costInsightsRouter = createTRPCRouter({
  getDashboard: baseProcedure.query(async ({ ctx }) => {
    return await buildCostInsightsDashboardData({
      database: db,
      owner: { type: 'user', id: ctx.user.id },
      uiOwner: { type: 'personal', name: ctx.user.google_user_name, authorizedRole: 'personal' },
    });
  }),
  getSettings: baseProcedure.query(async ({ ctx }) => {
    return await buildCostInsightsSettingsData({
      database: db,
      owner: { type: 'user', id: ctx.user.id },
      uiOwner: { type: 'personal', name: ctx.user.google_user_name, authorizedRole: 'personal' },
    });
  }),
  listEvents: baseProcedure.query(async ({ ctx }) => {
    return await buildCostInsightsEventHistoryData({
      database: db,
      owner: { type: 'user', id: ctx.user.id },
    });
  }),
  getAttentionState: baseProcedure.query(async ({ ctx }) => {
    return {
      attention: (await ownerHasUnreviewedCostInsightAlert(db, {
        type: 'user',
        id: ctx.user.id,
      }))
        ? 'alert'
        : 'none',
    };
  }),
  updateSettings: baseProcedure
    .input(UpdateCostInsightsSettingsSchema)
    .mutation(async ({ ctx, input }) => {
      return await updateOwnerSettings({
        owner: { type: 'user', id: ctx.user.id },
        actorUserId: ctx.user.id,
        input,
      });
    }),
  acknowledgeAlert: baseProcedure
    .input(AcknowledgeCostInsightAlertSchema)
    .mutation(async ({ ctx, input }) => {
      await acknowledgeCostInsightAlert(db, {
        owner: { type: 'user', id: ctx.user.id },
        alertKind: input.alertKind,
        actorUserId: ctx.user.id,
      });
      return { success: true };
    }),
  dismissSuggestion: baseProcedure
    .input(DismissCostInsightSuggestionSchema)
    .mutation(async ({ ctx, input }) => {
      await dismissCostInsightSuggestion(db, {
        owner: { type: 'user', id: ctx.user.id },
        suggestionId: input.suggestionId,
        actorUserId: ctx.user.id,
      });
      return { success: true };
    }),
});

export const costInsightsRouterInternals = {
  updateOwnerSettings,
  UpdateCostInsightsSettingsSchema,
  AcknowledgeCostInsightAlertSchema,
  DismissCostInsightSuggestionSchema,
};
