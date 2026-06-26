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
  countOpenCostInsightReviewItems,
  dismissCostInsightSuggestion,
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

const CostInsightEventHistorySchema = z.object({
  filter: z.enum(['all', 'alerts', 'suggestions', 'reviews', 'settings']),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(50),
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
  if (current.spend_alerts_enabled) {
    await evaluateCostInsightsForOwner(db, params.owner);
  }
  return { success: true };
}

async function disableOwnerThreshold(params: {
  owner: { type: 'user'; id: string } | { type: 'organization'; id: string };
  actorUserId: string;
}) {
  return await db.transaction(async database => {
    const { previous, current } = await updateCostInsightOwnerConfig(database, params.owner, {
      spendThresholdMicrodollars: null,
    });
    await clearCostInsightThresholdEpisode(database, params.owner, null);

    if (previous.spend_threshold_microdollars === null) return { success: true };

    if (current.spend_alerts_enabled) {
      await createCostInsightEvent(database, {
        owner: params.owner,
        eventType: 'config_changed',
        actorUserId: params.actorUserId,
        title: 'Cost Insights settings changed',
        description: 'Spend threshold was turned off.',
        snapshot: {
          changedFields: changedFields(previous, current),
          settings: {
            spendAlertsEnabled: current.spend_alerts_enabled,
            costSuggestionsEnabled: current.cost_suggestions_enabled,
            spendThresholdMicrodollars: current.spend_threshold_microdollars,
          },
        },
      });
    }

    return { success: true };
  });
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
  listEvents: baseProcedure.input(CostInsightEventHistorySchema).query(async ({ ctx, input }) => {
    return await buildCostInsightsEventHistoryData({
      database: db,
      owner: { type: 'user', id: ctx.user.id },
      filter: input.filter,
      page: input.page,
      pageSize: input.pageSize,
    });
  }),
  getAttentionState: baseProcedure.query(async ({ ctx }) => {
    const reviewItemCount = await countOpenCostInsightReviewItems(db, {
      type: 'user',
      id: ctx.user.id,
    });
    return {
      attention: reviewItemCount > 0 ? 'alert' : 'none',
      reviewItemCount,
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
  disableThreshold: baseProcedure.mutation(async ({ ctx }) => {
    return await disableOwnerThreshold({
      owner: { type: 'user', id: ctx.user.id },
      actorUserId: ctx.user.id,
    });
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
  disableOwnerThreshold,
  UpdateCostInsightsSettingsSchema,
  AcknowledgeCostInsightAlertSchema,
  DismissCostInsightSuggestionSchema,
  CostInsightEventHistorySchema,
};
