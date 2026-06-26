import { TRPCError } from '@trpc/server';
import * as z from 'zod';

import { db } from '@/lib/drizzle';
import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  buildCostInsightsDashboardData,
  buildCostInsightsEventHistoryData,
  buildCostInsightsSettingsData,
} from '@/lib/cost-insights/presenter';
import {
  acknowledgeCostInsightAlert,
  clearCostInsightAlertState,
  clearCostInsightAnomalyEpisode,
  clearCostInsightThresholdEpisode,
  createCostInsightEvent,
  countOpenCostInsightReviewItems,
  dismissCostInsightSuggestion,
  updateCostInsightOwnerConfig,
} from '@/lib/cost-insights/repository';
import { evaluateCostInsightsForOwner } from '@/lib/cost-insights/evaluation';
import { parseSpendThresholdUsd } from '@/lib/cost-insights/policy';
import {
  trackCostInsightsAlertAction,
  trackCostInsightsSettingsSaved,
  trackCostInsightsSuggestionAction,
  trackCostInsightsUiInteraction,
  type CostInsightsTrackingContext,
} from '@/lib/cost-insights/posthog-tracking';
import {
  CostInsightsSuggestionCtaSchema,
  CostInsightsUiInteractionSchema,
  OrganizationCostInsightsSuggestionCtaSchema,
  OrganizationCostInsightsUiInteractionSchema,
} from '@/lib/cost-insights/tracking';

const UpdateCostInsightsSettingsSchema = z.object({
  spendAlertsEnabled: z.boolean(),
  anomalyAlertsEnabled: z.boolean(),
  costSuggestionsEnabled: z.boolean(),
  spendThresholdUsd: z.string().nullable(),
  spend7DayThresholdUsd: z.string().nullable(),
  spend30DayThresholdUsd: z.string().nullable(),
});

const AcknowledgeCostInsightAlertSchema = z.object({
  alertKind: z.enum(['anomaly', 'threshold', 'threshold_7d', 'threshold_30d']),
});

const DismissCostInsightSuggestionSchema = z.object({
  suggestionId: z.uuid(),
});

const CostInsightEventHistorySchema = z.object({
  filter: z.enum(['all', 'alerts', 'suggestions', 'reviews', 'settings']),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(50),
});

function personalTrackingContext(userId: string): CostInsightsTrackingContext {
  return {
    distinctId: userId,
    userId,
    ownerType: 'personal',
    authorizedRole: 'personal',
  };
}

function booleanTransition(previous: boolean, current: boolean) {
  if (previous === current) return 'unchanged' as const;
  return current ? ('enabled' as const) : ('disabled' as const);
}

function thresholdTransition(previous: number | null, current: number | null) {
  if (previous === current) return 'unchanged' as const;
  if (previous === null) return 'added' as const;
  if (current === null) return 'removed' as const;
  return 'changed' as const;
}

function trackSettingsSaved(
  trackingContext: CostInsightsTrackingContext,
  previous: {
    spend_alerts_enabled: boolean;
    anomaly_alerts_enabled: boolean;
    cost_suggestions_enabled: boolean;
    spend_threshold_microdollars: number | null;
    spend_7_day_threshold_microdollars: number | null;
    spend_30_day_threshold_microdollars: number | null;
  },
  current: {
    spend_alerts_enabled: boolean;
    anomaly_alerts_enabled: boolean;
    cost_suggestions_enabled: boolean;
    spend_threshold_microdollars: number | null;
    spend_7_day_threshold_microdollars: number | null;
    spend_30_day_threshold_microdollars: number | null;
  }
) {
  trackCostInsightsSettingsSaved({
    ...trackingContext,
    spendAlertsTransition: booleanTransition(
      previous.spend_alerts_enabled,
      current.spend_alerts_enabled
    ),
    anomalyAlertsTransition: booleanTransition(
      previous.anomaly_alerts_enabled,
      current.anomaly_alerts_enabled
    ),
    costSuggestionsTransition: booleanTransition(
      previous.cost_suggestions_enabled,
      current.cost_suggestions_enabled
    ),
    threshold24hTransition: thresholdTransition(
      previous.spend_threshold_microdollars,
      current.spend_threshold_microdollars
    ),
    threshold7dTransition: thresholdTransition(
      previous.spend_7_day_threshold_microdollars,
      current.spend_7_day_threshold_microdollars
    ),
    threshold30dTransition: thresholdTransition(
      previous.spend_30_day_threshold_microdollars,
      current.spend_30_day_threshold_microdollars
    ),
    spendAlertsEnabled: current.spend_alerts_enabled,
    anomalyAlertsEnabled: current.anomaly_alerts_enabled,
    costSuggestionsEnabled: current.cost_suggestions_enabled,
    threshold24hConfigured: current.spend_threshold_microdollars !== null,
    threshold7dConfigured: current.spend_7_day_threshold_microdollars !== null,
    threshold30dConfigured: current.spend_30_day_threshold_microdollars !== null,
  });
}

function changedFields(
  previous: {
    spend_alerts_enabled: boolean;
    anomaly_alerts_enabled: boolean;
    cost_suggestions_enabled: boolean;
    spend_threshold_microdollars: number | null;
    spend_7_day_threshold_microdollars: number | null;
    spend_30_day_threshold_microdollars: number | null;
  },
  current: {
    spend_alerts_enabled: boolean;
    anomaly_alerts_enabled: boolean;
    cost_suggestions_enabled: boolean;
    spend_threshold_microdollars: number | null;
    spend_7_day_threshold_microdollars: number | null;
    spend_30_day_threshold_microdollars: number | null;
  }
) {
  const fields: Record<string, { old: unknown; new: unknown }> = {};
  if (previous.spend_alerts_enabled !== current.spend_alerts_enabled) {
    fields.spendAlertsEnabled = {
      old: previous.spend_alerts_enabled,
      new: current.spend_alerts_enabled,
    };
  }
  if (previous.anomaly_alerts_enabled !== current.anomaly_alerts_enabled) {
    fields.anomalyAlertsEnabled = {
      old: previous.anomaly_alerts_enabled,
      new: current.anomaly_alerts_enabled,
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
  if (previous.spend_7_day_threshold_microdollars !== current.spend_7_day_threshold_microdollars) {
    fields.spend7DayThresholdMicrodollars = {
      old: previous.spend_7_day_threshold_microdollars,
      new: current.spend_7_day_threshold_microdollars,
    };
  }
  if (
    previous.spend_30_day_threshold_microdollars !== current.spend_30_day_threshold_microdollars
  ) {
    fields.spend30DayThresholdMicrodollars = {
      old: previous.spend_30_day_threshold_microdollars,
      new: current.spend_30_day_threshold_microdollars,
    };
  }
  return fields;
}

function settingsSnapshot(config: {
  spend_alerts_enabled: boolean;
  anomaly_alerts_enabled: boolean;
  cost_suggestions_enabled: boolean;
  spend_threshold_microdollars: number | null;
  spend_7_day_threshold_microdollars: number | null;
  spend_30_day_threshold_microdollars: number | null;
}) {
  return {
    spendAlertsEnabled: config.spend_alerts_enabled,
    anomalyAlertsEnabled: config.anomaly_alerts_enabled,
    costSuggestionsEnabled: config.cost_suggestions_enabled,
    spendThresholdMicrodollars: config.spend_threshold_microdollars,
    spend7DayThresholdMicrodollars: config.spend_7_day_threshold_microdollars,
    spend30DayThresholdMicrodollars: config.spend_30_day_threshold_microdollars,
  };
}

async function updateOwnerSettings(params: {
  owner: { type: 'user'; id: string } | { type: 'organization'; id: string };
  actorUserId: string;
  trackingContext: CostInsightsTrackingContext;
  input: z.infer<typeof UpdateCostInsightsSettingsSchema>;
}) {
  let spendThresholdMicrodollars: number | null;
  let spend7DayThresholdMicrodollars: number | null;
  let spend30DayThresholdMicrodollars: number | null;
  try {
    spendThresholdMicrodollars = parseSpendThresholdUsd(params.input.spendThresholdUsd);
    spend7DayThresholdMicrodollars = parseSpendThresholdUsd(params.input.spend7DayThresholdUsd);
    spend30DayThresholdMicrodollars = parseSpendThresholdUsd(params.input.spend30DayThresholdUsd);
  } catch (error) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: error instanceof Error ? error.message : 'Invalid spend threshold.',
    });
  }

  const { previous, current } = await updateCostInsightOwnerConfig(db, params.owner, {
    spendAlertsEnabled: params.input.spendAlertsEnabled,
    anomalyAlertsEnabled: params.input.anomalyAlertsEnabled,
    costSuggestionsEnabled: params.input.costSuggestionsEnabled,
    spendThresholdMicrodollars,
    spend7DayThresholdMicrodollars,
    spend30DayThresholdMicrodollars,
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
        settings: settingsSnapshot(current),
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
        settings: settingsSnapshot(current),
      },
    });
  }

  if (previous.anomaly_alerts_enabled && !current.anomaly_alerts_enabled) {
    await clearCostInsightAnomalyEpisode(db, params.owner);
  }
  if (
    previous.spend_threshold_microdollars !== null &&
    current.spend_threshold_microdollars === null
  ) {
    await clearCostInsightThresholdEpisode(db, params.owner, null, 'threshold');
  }
  if (
    previous.spend_7_day_threshold_microdollars !== null &&
    current.spend_7_day_threshold_microdollars === null
  ) {
    await clearCostInsightThresholdEpisode(db, params.owner, null, 'threshold_7d');
  }
  if (
    previous.spend_30_day_threshold_microdollars !== null &&
    current.spend_30_day_threshold_microdollars === null
  ) {
    await clearCostInsightThresholdEpisode(db, params.owner, null, 'threshold_30d');
  }
  if (current.spend_alerts_enabled) {
    await evaluateCostInsightsForOwner(db, params.owner);
  }
  if (hasChanges) {
    trackSettingsSaved(params.trackingContext, previous, current);
  }
  return { success: true };
}

async function disableOwnerThreshold(params: {
  owner: { type: 'user'; id: string } | { type: 'organization'; id: string };
  actorUserId: string;
  trackingContext: CostInsightsTrackingContext;
}) {
  const result = await db.transaction(async database => {
    const { previous, current } = await updateCostInsightOwnerConfig(database, params.owner, {
      spendThresholdMicrodollars: null,
    });
    await clearCostInsightThresholdEpisode(database, params.owner, null);

    if (previous.spend_threshold_microdollars === null) {
      return { success: true, previous, current, changed: false };
    }

    if (current.spend_alerts_enabled) {
      await createCostInsightEvent(database, {
        owner: params.owner,
        eventType: 'config_changed',
        actorUserId: params.actorUserId,
        title: 'Cost Insights settings changed',
        description: 'Spend threshold was turned off.',
        snapshot: {
          changedFields: changedFields(previous, current),
          settings: settingsSnapshot(current),
        },
      });
    }

    return { success: true, previous, current, changed: true };
  });
  if (result.changed) {
    trackSettingsSaved(params.trackingContext, result.previous, result.current);
  }
  return { success: result.success };
}

export const costInsightsRouter = createTRPCRouter({
  trackUiInteraction: adminProcedure
    .input(CostInsightsUiInteractionSchema)
    .mutation(async ({ ctx, input }) => {
      trackCostInsightsUiInteraction(personalTrackingContext(ctx.user.id), input);
      return { success: true };
    }),
  trackSuggestionCta: adminProcedure
    .input(CostInsightsSuggestionCtaSchema)
    .mutation(async ({ ctx, input }) => {
      trackCostInsightsSuggestionAction({
        ...personalTrackingContext(ctx.user.id),
        action: 'open_cta',
        suggestionKind: input.suggestionKind,
        phase: 'clicked',
      });
      return { success: true };
    }),
  getDashboard: adminProcedure.query(async ({ ctx }) => {
    return await buildCostInsightsDashboardData({
      database: db,
      owner: { type: 'user', id: ctx.user.id },
      uiOwner: { type: 'personal', name: ctx.user.google_user_name, authorizedRole: 'personal' },
    });
  }),
  getSettings: adminProcedure.query(async ({ ctx }) => {
    return await buildCostInsightsSettingsData({
      database: db,
      owner: { type: 'user', id: ctx.user.id },
      uiOwner: { type: 'personal', name: ctx.user.google_user_name, authorizedRole: 'personal' },
    });
  }),
  listEvents: adminProcedure.input(CostInsightEventHistorySchema).query(async ({ ctx, input }) => {
    return await buildCostInsightsEventHistoryData({
      database: db,
      owner: { type: 'user', id: ctx.user.id },
      filter: input.filter,
      page: input.page,
      pageSize: input.pageSize,
    });
  }),
  getAttentionState: adminProcedure.query(async ({ ctx }) => {
    const reviewItemCount = await countOpenCostInsightReviewItems(db, {
      type: 'user',
      id: ctx.user.id,
    });
    return {
      attention: reviewItemCount > 0 ? 'alert' : 'none',
      reviewItemCount,
    };
  }),
  updateSettings: adminProcedure
    .input(UpdateCostInsightsSettingsSchema)
    .mutation(async ({ ctx, input }) => {
      return await updateOwnerSettings({
        owner: { type: 'user', id: ctx.user.id },
        actorUserId: ctx.user.id,
        trackingContext: personalTrackingContext(ctx.user.id),
        input,
      });
    }),
  acknowledgeAlert: adminProcedure
    .input(AcknowledgeCostInsightAlertSchema)
    .mutation(async ({ ctx, input }) => {
      const acknowledged = await acknowledgeCostInsightAlert(db, {
        owner: { type: 'user', id: ctx.user.id },
        alertKind: input.alertKind,
        actorUserId: ctx.user.id,
      });
      if (acknowledged) {
        trackCostInsightsAlertAction({
          ...personalTrackingContext(ctx.user.id),
          action: 'acknowledge',
          alertKind: input.alertKind,
        });
      }
      return { success: true };
    }),
  disableThreshold: adminProcedure.mutation(async ({ ctx }) => {
    return await disableOwnerThreshold({
      owner: { type: 'user', id: ctx.user.id },
      actorUserId: ctx.user.id,
      trackingContext: personalTrackingContext(ctx.user.id),
    });
  }),
  dismissSuggestion: adminProcedure
    .input(DismissCostInsightSuggestionSchema)
    .mutation(async ({ ctx, input }) => {
      const suggestionKind = await dismissCostInsightSuggestion(db, {
        owner: { type: 'user', id: ctx.user.id },
        suggestionId: input.suggestionId,
        actorUserId: ctx.user.id,
      });
      if (suggestionKind) {
        trackCostInsightsSuggestionAction({
          ...personalTrackingContext(ctx.user.id),
          action: 'dismiss',
          suggestionKind,
          phase: 'accepted',
        });
      }
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
  CostInsightsUiInteractionSchema,
  CostInsightsSuggestionCtaSchema,
  OrganizationCostInsightsUiInteractionSchema,
  OrganizationCostInsightsSuggestionCtaSchema,
};
