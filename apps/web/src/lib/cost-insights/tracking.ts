import * as z from 'zod';

const SpendRangeSchema = z.enum(['1h', '24h', '7d', '30d', '90d']);
const AlertKindSchema = z.enum(['anomaly', 'threshold', 'threshold_7d', 'threshold_30d']);
const ActivityFilterSchema = z.enum(['all', 'alerts', 'suggestions', 'reviews', 'settings']);

const DashboardViewedSchema = z
  .object({
    interaction: z.literal('dashboard_viewed'),
    spendAlertsEnabled: z.boolean(),
    hasActiveAlert: z.boolean(),
    hasActiveSuggestion: z.boolean(),
  })
  .strict();
const SettingsViewedSchema = z
  .object({
    interaction: z.literal('settings_viewed'),
    spendAlertsEnabled: z.boolean(),
    costSuggestionsEnabled: z.boolean(),
    threshold24hConfigured: z.boolean(),
    threshold7dConfigured: z.boolean(),
    threshold30dConfigured: z.boolean(),
    readOnly: z.boolean(),
  })
  .strict();
const ActivityViewedSchema = z.object({ interaction: z.literal('activity_viewed') }).strict();
const AskKiloViewedSchema = z.object({ interaction: z.literal('ask_kilo_viewed') }).strict();
const SpendRangeSelectedSchema = z
  .object({
    interaction: z.literal('spend_range_selected'),
    range: SpendRangeSchema,
  })
  .strict();
const AlertDriversExpandedSchema = z
  .object({
    interaction: z.literal('alert_drivers_expanded'),
    alertKind: AlertKindSchema,
  })
  .strict();
const SetupAlertsClickedSchema = z
  .object({ interaction: z.literal('setup_alerts_clicked') })
  .strict();
const AlertSettingsClickedSchema = z
  .object({
    interaction: z.literal('alert_settings_clicked'),
    action: z.enum(['manage_threshold', 'disable_alerts']),
  })
  .strict();
const ActivityFilterSelectedSchema = z
  .object({
    interaction: z.literal('activity_filter_selected'),
    filter: ActivityFilterSchema,
  })
  .strict();
const ActivityPageSelectedSchema = z
  .object({
    interaction: z.literal('activity_page_selected'),
    direction: z.enum(['next', 'previous']),
  })
  .strict();
const AskKiloQuestionSubmittedSchema = z
  .object({
    interaction: z.literal('ask_kilo_question_submitted'),
    source: z.enum(['dashboard', 'follow_up']),
    experience: z.literal('ui_only'),
  })
  .strict();

export const CostInsightsUiInteractionSchema = z.discriminatedUnion('interaction', [
  DashboardViewedSchema,
  SettingsViewedSchema,
  ActivityViewedSchema,
  AskKiloViewedSchema,
  SpendRangeSelectedSchema,
  AlertDriversExpandedSchema,
  SetupAlertsClickedSchema,
  AlertSettingsClickedSchema,
  ActivityFilterSelectedSchema,
  ActivityPageSelectedSchema,
  AskKiloQuestionSubmittedSchema,
]);

const OrganizationIdField = { organizationId: z.uuid() };

export const OrganizationCostInsightsUiInteractionSchema = z.discriminatedUnion('interaction', [
  DashboardViewedSchema.extend(OrganizationIdField),
  SettingsViewedSchema.extend(OrganizationIdField),
  ActivityViewedSchema.extend(OrganizationIdField),
  AskKiloViewedSchema.extend(OrganizationIdField),
  SpendRangeSelectedSchema.extend(OrganizationIdField),
  AlertDriversExpandedSchema.extend(OrganizationIdField),
  SetupAlertsClickedSchema.extend(OrganizationIdField),
  AlertSettingsClickedSchema.extend(OrganizationIdField),
  ActivityFilterSelectedSchema.extend(OrganizationIdField),
  ActivityPageSelectedSchema.extend(OrganizationIdField),
  AskKiloQuestionSubmittedSchema.extend(OrganizationIdField),
]);

export const CostInsightsSuggestionCtaSchema = z
  .object({
    suggestionKind: z.enum(['coding_plan', 'kilo_pass']),
  })
  .strict();

export const OrganizationCostInsightsSuggestionCtaSchema = CostInsightsSuggestionCtaSchema.extend({
  organizationId: z.uuid(),
});

export type CostInsightsUiInteraction = z.infer<typeof CostInsightsUiInteractionSchema>;
export type CostInsightsSuggestionCta = z.infer<typeof CostInsightsSuggestionCtaSchema>;
