import type { CostInsightSpendOwner } from '@kilocode/db/cost-insights-rollups';
import {
  cost_insight_active_suggestions,
  cost_insight_events,
  cost_insight_notification_deliveries,
  cost_insight_owner_configs,
  cost_insight_owner_states,
  kilocode_users,
  organization_memberships,
  organizations,
  type CostInsightEventSnapshot,
  type CostInsightOwnerConfig,
  type CostInsightOwnerState,
} from '@kilocode/db/schema';
import type {
  CostInsightAlertKind,
  CostInsightEventType,
  CostInsightSuggestionKind,
} from '@kilocode/db/schema-types';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import type { db } from '@/lib/drizzle';
import {
  costInsightOwnerInsertValues,
  costInsightOwnerTargetColumn,
  costInsightOwnerTargetWhere,
  costInsightOwnerWhere,
} from './owner';

export type CostInsightDatabase = typeof db;

export type CostInsightConfigPatch = {
  spendAlertsEnabled?: boolean;
  costSuggestionsEnabled?: boolean;
  spendThresholdMicrodollars?: number | null;
};

export type CostInsightEventInput = {
  owner: CostInsightSpendOwner;
  eventType: CostInsightEventType;
  alertKind?: CostInsightAlertKind;
  suggestionKind?: CostInsightSuggestionKind;
  activeSuggestionId?: string | null;
  actorUserId?: string | null;
  title: string;
  description: string;
  snapshot?: CostInsightEventSnapshot;
  dedupeKey?: string | null;
};

export type CostInsightSuggestionInput = {
  owner: CostInsightSpendOwner;
  suggestionKind: CostInsightSuggestionKind;
  suggestionKey: string;
  title: string;
  description: string;
  ctaLabel: string;
  ctaHref: string;
  evidenceWindowStart: string;
  evidenceWindowEnd: string;
  observedMicrodollars: number;
  benefitLabel: string;
  benefitDetail: string;
};

export async function getCostInsightOwnerConfig(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner
): Promise<CostInsightOwnerConfig | null> {
  const [config] = await database
    .select()
    .from(cost_insight_owner_configs)
    .where(costInsightOwnerWhere(owner, cost_insight_owner_configs))
    .limit(1);
  return config ?? null;
}

export async function getOrCreateCostInsightOwnerConfig(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner
): Promise<CostInsightOwnerConfig> {
  const existing = await getCostInsightOwnerConfig(database, owner);
  if (existing) return existing;

  const [config] = await database
    .insert(cost_insight_owner_configs)
    .values(costInsightOwnerInsertValues(owner))
    .onConflictDoUpdate({
      target: costInsightOwnerTargetColumn(owner, cost_insight_owner_configs),
      targetWhere: costInsightOwnerTargetWhere(owner, cost_insight_owner_configs),
      set: {
        updated_at: sql`now()`,
      },
    })
    .returning();
  if (!config) throw new Error('Cost Insights config upsert returned no row.');
  return config;
}

export async function updateCostInsightOwnerConfig(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner,
  patch: CostInsightConfigPatch
): Promise<{ previous: CostInsightOwnerConfig; current: CostInsightOwnerConfig }> {
  const previous = await getOrCreateCostInsightOwnerConfig(database, owner);
  const nextSpendAlertsEnabled = patch.spendAlertsEnabled ?? previous.spend_alerts_enabled;

  const [current] = await database
    .update(cost_insight_owner_configs)
    .set({
      spend_alerts_enabled: nextSpendAlertsEnabled,
      cost_suggestions_enabled: patch.costSuggestionsEnabled ?? previous.cost_suggestions_enabled,
      spend_threshold_microdollars:
        patch.spendThresholdMicrodollars === undefined
          ? previous.spend_threshold_microdollars
          : patch.spendThresholdMicrodollars,
      spend_alerts_enabled_at: nextSpendAlertsEnabled
        ? (previous.spend_alerts_enabled_at ?? sql`now()`)
        : null,
      updated_at: sql`now()`,
    })
    .where(eq(cost_insight_owner_configs.id, previous.id))
    .returning();

  if (!current) throw new Error('Cost Insights config update returned no row.');
  return { previous, current };
}

export async function getOrCreateCostInsightOwnerState(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner
): Promise<CostInsightOwnerState> {
  const [state] = await database
    .insert(cost_insight_owner_states)
    .values(costInsightOwnerInsertValues(owner))
    .onConflictDoUpdate({
      target: costInsightOwnerTargetColumn(owner, cost_insight_owner_states),
      targetWhere: costInsightOwnerTargetWhere(owner, cost_insight_owner_states),
      set: {
        updated_at: sql`now()`,
      },
    })
    .returning();
  if (!state) throw new Error('Cost Insights state upsert returned no row.');
  return state;
}

export async function clearCostInsightAlertState(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner
): Promise<void> {
  const state = await getOrCreateCostInsightOwnerState(database, owner);
  await database
    .update(cost_insight_owner_states)
    .set({
      active_anomaly_event_id: null,
      active_anomaly_hour_start: null,
      active_anomaly_reviewed_at: null,
      threshold_crossing_active: false,
      active_threshold_event_id: null,
      threshold_crossing_started_at: null,
      threshold_reviewed_at: null,
      updated_at: sql`now()`,
    })
    .where(eq(cost_insight_owner_states.id, state.id));
}

export async function markCostInsightEvaluation(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner,
  asOf: string
): Promise<void> {
  const state = await getOrCreateCostInsightOwnerState(database, owner);
  await database
    .update(cost_insight_owner_states)
    .set({ last_evaluated_at: asOf, updated_at: sql`now()` })
    .where(eq(cost_insight_owner_states.id, state.id));
}

export async function createCostInsightEvent(
  database: CostInsightDatabase,
  input: CostInsightEventInput
): Promise<{ id: string; created: boolean }> {
  const [event] = await database
    .insert(cost_insight_events)
    .values({
      ...costInsightOwnerInsertValues(input.owner),
      event_type: input.eventType,
      alert_kind: input.alertKind ?? null,
      suggestion_kind: input.suggestionKind ?? null,
      active_suggestion_id: input.activeSuggestionId ?? null,
      actor_user_id: input.actorUserId ?? null,
      title: input.title,
      description: input.description,
      snapshot: input.snapshot ?? {},
      dedupe_key: input.dedupeKey ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: cost_insight_events.id });

  if (event) return { id: event.id, created: true };
  if (!input.dedupeKey) throw new Error('Cost Insights event insert returned no row.');

  const [existing] = await database
    .select({ id: cost_insight_events.id })
    .from(cost_insight_events)
    .where(
      and(
        costInsightOwnerWhere(input.owner, cost_insight_events),
        eq(cost_insight_events.dedupe_key, input.dedupeKey)
      )
    )
    .limit(1);
  if (!existing) throw new Error('Cost Insights deduped event could not be loaded.');
  return { id: existing.id, created: false };
}

export async function createCostInsightNotificationDeliveries(
  database: CostInsightDatabase,
  eventId: string,
  recipientUserIds: string[]
): Promise<number> {
  const uniqueRecipientUserIds = [...new Set(recipientUserIds)].sort();
  if (uniqueRecipientUserIds.length === 0) return 0;
  const rows = await database
    .insert(cost_insight_notification_deliveries)
    .values(
      uniqueRecipientUserIds.map(recipient_user_id => ({ event_id: eventId, recipient_user_id }))
    )
    .onConflictDoNothing()
    .returning({ id: cost_insight_notification_deliveries.id });
  return rows.length;
}

export async function listCostInsightNotificationRecipientUserIds(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner
): Promise<string[]> {
  if (owner.type === 'user') return [owner.id];

  const rows = await database
    .select({ userId: organization_memberships.kilo_user_id })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, owner.id),
        inArray(organization_memberships.role, ['owner', 'billing_manager'])
      )
    )
    .orderBy(organization_memberships.kilo_user_id);
  return rows.map(row => row.userId);
}

export async function listEnabledCostInsightOwners(
  database: CostInsightDatabase
): Promise<CostInsightSpendOwner[]> {
  const rows = await database
    .select({
      userId: cost_insight_owner_configs.owned_by_user_id,
      organizationId: cost_insight_owner_configs.owned_by_organization_id,
    })
    .from(cost_insight_owner_configs)
    .where(
      or(
        eq(cost_insight_owner_configs.spend_alerts_enabled, true),
        eq(cost_insight_owner_configs.cost_suggestions_enabled, true)
      )
    )
    .orderBy(cost_insight_owner_configs.updated_at, cost_insight_owner_configs.id);

  return rows.map(row => {
    if (row.userId) return { type: 'user', id: row.userId };
    if (row.organizationId) return { type: 'organization', id: row.organizationId };
    throw new Error('Cost Insights enabled config row has no owner.');
  });
}

export async function listCostInsightEvents(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner,
  limit = 50
) {
  return await database
    .select({
      id: cost_insight_events.id,
      eventType: cost_insight_events.event_type,
      alertKind: cost_insight_events.alert_kind,
      suggestionKind: cost_insight_events.suggestion_kind,
      actorUserId: cost_insight_events.actor_user_id,
      actorName: kilocode_users.google_user_name,
      title: cost_insight_events.title,
      description: cost_insight_events.description,
      snapshot: cost_insight_events.snapshot,
      occurredAt: cost_insight_events.occurred_at,
    })
    .from(cost_insight_events)
    .leftJoin(kilocode_users, eq(kilocode_users.id, cost_insight_events.actor_user_id))
    .where(costInsightOwnerWhere(owner, cost_insight_events))
    .orderBy(desc(cost_insight_events.occurred_at), desc(cost_insight_events.id))
    .limit(limit);
}

export async function getCostInsightDashboardState(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner
) {
  const [state] = await database
    .select({
      activeAnomalyEventId: cost_insight_owner_states.active_anomaly_event_id,
      activeAnomalyHourStart: cost_insight_owner_states.active_anomaly_hour_start,
      activeAnomalyReviewedAt: cost_insight_owner_states.active_anomaly_reviewed_at,
      activeThresholdEventId: cost_insight_owner_states.active_threshold_event_id,
      thresholdCrossingActive: cost_insight_owner_states.threshold_crossing_active,
      thresholdReviewedAt: cost_insight_owner_states.threshold_reviewed_at,
      lastEvaluatedAt: cost_insight_owner_states.last_evaluated_at,
    })
    .from(cost_insight_owner_states)
    .where(costInsightOwnerWhere(owner, cost_insight_owner_states))
    .limit(1);

  const eventIds = [state?.activeAnomalyEventId, state?.activeThresholdEventId].filter(
    (id): id is string => Boolean(id)
  );

  const events =
    eventIds.length === 0
      ? []
      : await database
          .select()
          .from(cost_insight_events)
          .where(inArray(cost_insight_events.id, eventIds));

  return { state: state ?? null, events };
}

export async function markCostInsightAnomalyEpisode(
  database: CostInsightDatabase,
  params: { owner: CostInsightSpendOwner; eventId: string; hourStart: string }
): Promise<void> {
  const state = await getOrCreateCostInsightOwnerState(database, params.owner);
  await database
    .update(cost_insight_owner_states)
    .set({
      active_anomaly_event_id: params.eventId,
      active_anomaly_hour_start: params.hourStart,
      active_anomaly_reviewed_at: null,
      updated_at: sql`now()`,
    })
    .where(eq(cost_insight_owner_states.id, state.id));
}

export async function markCostInsightThresholdEpisode(
  database: CostInsightDatabase,
  params: { owner: CostInsightSpendOwner; eventId: string; crossedAt: string }
): Promise<void> {
  const state = await getOrCreateCostInsightOwnerState(database, params.owner);
  await database
    .update(cost_insight_owner_states)
    .set({
      threshold_crossing_active: true,
      active_threshold_event_id: params.eventId,
      threshold_crossing_started_at: params.crossedAt,
      threshold_reviewed_at: null,
      threshold_recovered_at: null,
      updated_at: sql`now()`,
    })
    .where(eq(cost_insight_owner_states.id, state.id));
}

export async function clearCostInsightThresholdEpisode(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner,
  recoveredAt: string | null
): Promise<void> {
  const state = await getOrCreateCostInsightOwnerState(database, owner);
  await database
    .update(cost_insight_owner_states)
    .set({
      threshold_crossing_active: false,
      active_threshold_event_id: null,
      threshold_crossing_started_at: null,
      threshold_reviewed_at: null,
      threshold_recovered_at: recoveredAt,
      updated_at: sql`now()`,
    })
    .where(eq(cost_insight_owner_states.id, state.id));
}

export async function acknowledgeCostInsightAlert(
  database: CostInsightDatabase,
  params: { owner: CostInsightSpendOwner; alertKind: CostInsightAlertKind; actorUserId: string }
): Promise<void> {
  const state = await getOrCreateCostInsightOwnerState(database, params.owner);
  const now = sql`now()`;
  await database
    .update(cost_insight_owner_states)
    .set(
      params.alertKind === 'anomaly'
        ? { active_anomaly_reviewed_at: now, updated_at: now }
        : { threshold_reviewed_at: now, updated_at: now }
    )
    .where(eq(cost_insight_owner_states.id, state.id));

  await createCostInsightEvent(database, {
    owner: params.owner,
    eventType: 'alert_reviewed',
    alertKind: params.alertKind,
    actorUserId: params.actorUserId,
    title:
      params.alertKind === 'anomaly'
        ? 'Spend Anomaly Alert reviewed'
        : 'Spend Threshold Alert reviewed',
    description: 'Alert acknowledgment recorded for the current episode.',
  });
}

export async function upsertCostInsightActiveSuggestion(
  database: CostInsightDatabase,
  input: CostInsightSuggestionInput
): Promise<{ id: string; created: boolean }> {
  const [suggestion] = await database
    .insert(cost_insight_active_suggestions)
    .values({
      ...costInsightOwnerInsertValues(input.owner),
      suggestion_kind: input.suggestionKind,
      suggestion_key: input.suggestionKey,
      title: input.title,
      description: input.description,
      cta_label: input.ctaLabel,
      cta_href: input.ctaHref,
      evidence_window_start: input.evidenceWindowStart,
      evidence_window_end: input.evidenceWindowEnd,
      observed_microdollars: input.observedMicrodollars,
      benefit_label: input.benefitLabel,
      benefit_detail: input.benefitDetail,
    })
    .onConflictDoNothing()
    .returning({ id: cost_insight_active_suggestions.id });

  if (suggestion) return { id: suggestion.id, created: true };

  const [existing] = await database
    .select({ id: cost_insight_active_suggestions.id })
    .from(cost_insight_active_suggestions)
    .where(
      and(
        costInsightOwnerWhere(input.owner, cost_insight_active_suggestions),
        eq(cost_insight_active_suggestions.suggestion_key, input.suggestionKey)
      )
    )
    .limit(1);
  if (!existing) throw new Error('Cost Insights suggestion upsert returned no row.');
  return { id: existing.id, created: false };
}

export async function listActiveCostInsightSuggestions(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner
) {
  return await database
    .select()
    .from(cost_insight_active_suggestions)
    .where(
      and(
        costInsightOwnerWhere(owner, cost_insight_active_suggestions),
        isNull(cost_insight_active_suggestions.dismissed_at)
      )
    )
    .orderBy(
      desc(cost_insight_active_suggestions.created_at),
      desc(cost_insight_active_suggestions.id)
    );
}

export async function dismissCostInsightSuggestion(
  database: CostInsightDatabase,
  params: { owner: CostInsightSpendOwner; suggestionId: string; actorUserId: string }
): Promise<void> {
  const [suggestion] = await database
    .update(cost_insight_active_suggestions)
    .set({
      dismissed_at: sql`now()`,
      dismissed_by_user_id: params.actorUserId,
      updated_at: sql`now()`,
    })
    .where(
      and(
        eq(cost_insight_active_suggestions.id, params.suggestionId),
        costInsightOwnerWhere(params.owner, cost_insight_active_suggestions),
        isNull(cost_insight_active_suggestions.dismissed_at)
      )
    )
    .returning();

  if (!suggestion) return;
  await createCostInsightEvent(database, {
    owner: params.owner,
    eventType: 'suggestion_dismissed',
    suggestionKind: suggestion.suggestion_kind,
    activeSuggestionId: suggestion.id,
    actorUserId: params.actorUserId,
    title: 'Cost Suggestion dismissed',
    description: suggestion.title,
    snapshot: {
      suggestion: {
        suggestionKey: suggestion.suggestion_key,
        evidenceWindowStart: suggestion.evidence_window_start,
        evidenceWindowEnd: suggestion.evidence_window_end,
        observedMicrodollars: suggestion.observed_microdollars,
        ctaHref: suggestion.cta_href,
      },
    },
  });
}

export async function hasCurrentCostInsightAccess(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner,
  userId: string
): Promise<boolean> {
  if (owner.type === 'user') return owner.id === userId;
  const [row] = await database
    .select({ id: organization_memberships.id })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, owner.id),
        eq(organization_memberships.kilo_user_id, userId),
        inArray(organization_memberships.role, ['owner', 'billing_manager'])
      )
    )
    .limit(1);
  return Boolean(row);
}

export async function getCostInsightOwnerName(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner
): Promise<string> {
  if (owner.type === 'user') {
    const [user] = await database
      .select({ name: kilocode_users.google_user_name })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, owner.id))
      .limit(1);
    return user?.name ?? 'Personal account';
  }
  const [organization] = await database
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, owner.id))
    .limit(1);
  return organization?.name ?? 'Organization';
}

export async function deleteExpiredCostInsightEvents(
  database: CostInsightDatabase,
  retentionCutoff: string
): Promise<number> {
  const rows = await database
    .delete(cost_insight_events)
    .where(lt(cost_insight_events.occurred_at, retentionCutoff))
    .returning({ id: cost_insight_events.id });
  return rows.length;
}

export async function ownerHasUnreviewedCostInsightAlert(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner
): Promise<boolean> {
  const [row] = await database
    .select({ id: cost_insight_owner_states.id })
    .from(cost_insight_owner_states)
    .where(
      and(
        costInsightOwnerWhere(owner, cost_insight_owner_states),
        or(
          and(
            isNull(cost_insight_owner_states.active_anomaly_reviewed_at),
            sql`${cost_insight_owner_states.active_anomaly_event_id} IS NOT NULL`
          ),
          and(
            isNull(cost_insight_owner_states.threshold_reviewed_at),
            sql`${cost_insight_owner_states.active_threshold_event_id} IS NOT NULL`
          )
        )
      )
    )
    .limit(1);
  return Boolean(row);
}
