import 'server-only';

import { captureException } from '@sentry/nextjs';

import PostHogClient from '@/lib/posthog';
import type { CostInsightsUiInteraction } from './tracking';

export type CostInsightsAuthorizedRole = 'personal' | 'owner' | 'billing_manager' | 'admin';

export type CostInsightsTrackingContext = {
  distinctId: string;
  userId: string;
  ownerType: 'personal' | 'organization';
  authorizedRole: CostInsightsAuthorizedRole;
  organizationId?: string;
};

type ConfigTransition = 'enabled' | 'disabled' | 'unchanged';
type ThresholdTransition = 'added' | 'changed' | 'removed' | 'unchanged';

type CostInsightsSettingsSavedEvent = CostInsightsTrackingContext & {
  spendAlertsTransition: ConfigTransition;
  anomalyAlertsTransition: ConfigTransition;
  costSuggestionsTransition: ConfigTransition;
  threshold24hTransition: ThresholdTransition;
  threshold7dTransition?: ThresholdTransition;
  threshold30dTransition: ThresholdTransition;
  spendAlertsEnabled: boolean;
  anomalyAlertsEnabled: boolean;
  costSuggestionsEnabled: boolean;
  threshold24hConfigured: boolean;
  threshold7dConfigured?: boolean;
  threshold30dConfigured: boolean;
};

type CostInsightsAlertActionEvent = CostInsightsTrackingContext & {
  action: 'acknowledge';
  alertKind: 'anomaly' | 'threshold' | 'threshold_7d' | 'threshold_30d';
};

type CostInsightsSuggestionActionEvent = CostInsightsTrackingContext & {
  action: 'open_cta' | 'dismiss';
  suggestionKind: 'coding_plan' | 'kilo_pass';
  phase: 'clicked' | 'accepted';
};

const posthogClient = PostHogClient();

function contextProperties(context: CostInsightsTrackingContext) {
  return {
    userId: context.userId,
    ownerType: context.ownerType,
    authorizedRole: context.authorizedRole,
    ...(context.organizationId === undefined ? {} : { organizationId: context.organizationId }),
  };
}

function captureCostInsightsEvent(params: {
  distinctId: string;
  event: string;
  source: string;
  properties: Record<string, unknown>;
}): void {
  try {
    posthogClient.capture({
      distinctId: params.distinctId,
      event: params.event,
      properties: params.properties,
    });
  } catch (error) {
    captureException(error, {
      tags: { source: params.source },
      extra: { properties: params.properties },
    });
  }
}

export function trackCostInsightsUiInteraction(
  context: CostInsightsTrackingContext,
  interaction: CostInsightsUiInteraction
): void {
  const interactionProperties = (() => {
    switch (interaction.interaction) {
      case 'dashboard_viewed':
        return {
          spendAlertsEnabled: interaction.spendAlertsEnabled,
          hasActiveAlert: interaction.hasActiveAlert,
          hasActiveSuggestion: interaction.hasActiveSuggestion,
        };
      case 'settings_viewed':
        return {
          spendAlertsEnabled: interaction.spendAlertsEnabled,
          costSuggestionsEnabled: interaction.costSuggestionsEnabled,
          threshold24hConfigured: interaction.threshold24hConfigured,
          threshold7dConfigured: interaction.threshold7dConfigured,
          threshold30dConfigured: interaction.threshold30dConfigured,
          readOnly: interaction.readOnly,
        };
      case 'spend_range_selected':
        return { range: interaction.range };
      case 'alert_drivers_expanded':
        return { alertKind: interaction.alertKind };
      case 'alert_settings_clicked':
        return { action: interaction.action };
      case 'activity_filter_selected':
        return { filter: interaction.filter };
      case 'activity_page_selected':
        return { direction: interaction.direction };
      case 'ask_kilo_question_submitted':
        return { source: interaction.source, experience: interaction.experience };
      case 'activity_viewed':
      case 'ask_kilo_viewed':
      case 'setup_alerts_clicked':
        return {};
    }
  })();
  const properties = {
    interaction: interaction.interaction,
    feature: 'cost-insights',
    operation: 'ui_interaction',
    ...contextProperties(context),
    ...interactionProperties,
  };

  captureCostInsightsEvent({
    distinctId: context.distinctId,
    event: 'cost_insights_ui_interaction',
    source: 'posthog_cost_insights_ui_interaction',
    properties,
  });
}

export function trackCostInsightsSettingsSaved(properties: CostInsightsSettingsSavedEvent): void {
  const eventProperties = {
    phase: 'accepted',
    spendAlertsTransition: properties.spendAlertsTransition,
    anomalyAlertsTransition: properties.anomalyAlertsTransition,
    costSuggestionsTransition: properties.costSuggestionsTransition,
    threshold24hTransition: properties.threshold24hTransition,
    ...(properties.threshold7dTransition === undefined
      ? {}
      : { threshold7dTransition: properties.threshold7dTransition }),
    threshold30dTransition: properties.threshold30dTransition,
    spendAlertsEnabled: properties.spendAlertsEnabled,
    anomalyAlertsEnabled: properties.anomalyAlertsEnabled,
    costSuggestionsEnabled: properties.costSuggestionsEnabled,
    threshold24hConfigured: properties.threshold24hConfigured,
    ...(properties.threshold7dConfigured === undefined
      ? {}
      : { threshold7dConfigured: properties.threshold7dConfigured }),
    threshold30dConfigured: properties.threshold30dConfigured,
    feature: 'cost-insights',
    operation: 'save_settings',
    ...contextProperties(properties),
  };

  captureCostInsightsEvent({
    distinctId: properties.distinctId,
    event: 'cost_insights_settings_saved',
    source: 'posthog_cost_insights_settings_saved',
    properties: eventProperties,
  });
}

export function trackCostInsightsAlertAction(properties: CostInsightsAlertActionEvent): void {
  const eventProperties = {
    action: properties.action,
    alertKind: properties.alertKind,
    phase: 'accepted',
    feature: 'cost-insights',
    operation: 'alert_action',
    ...contextProperties(properties),
  };

  captureCostInsightsEvent({
    distinctId: properties.distinctId,
    event: 'cost_insights_alert_action',
    source: 'posthog_cost_insights_alert_action',
    properties: eventProperties,
  });
}

export function trackCostInsightsSuggestionAction(
  properties: CostInsightsSuggestionActionEvent
): void {
  const eventProperties = {
    action: properties.action,
    suggestionKind: properties.suggestionKind,
    phase: properties.phase,
    feature: 'cost-insights',
    operation: 'suggestion_action',
    ...contextProperties(properties),
  };

  captureCostInsightsEvent({
    distinctId: properties.distinctId,
    event: 'cost_insights_suggestion_action',
    source: 'posthog_cost_insights_suggestion_action',
    properties: eventProperties,
  });
}
