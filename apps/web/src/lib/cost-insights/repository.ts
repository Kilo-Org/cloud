import type { CostInsightSpendOwner } from '@kilocode/db/cost-insights-rollups';
import {
  cost_insight_active_suggestions,
  cost_insight_events,
  cost_insight_notification_deliveries,
  cost_insight_owner_configs,
  cost_insight_owner_states,
  CostInsightEventSnapshotSchema,
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
import { and, count, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import type { db, DrizzleTransaction } from '@/lib/drizzle';
import {
  costInsightOwnerInsertValues,
  costInsightOwnerTargetColumn,
  costInsightOwnerTargetWhere,
  costInsightOwnerWhere,
} from './owner';

export type CostInsightDatabase = typeof db | DrizzleTransaction;
export type CostInsightRootDatabase = typeof db;
export type CostInsightEventFilter = 'all' | 'alerts' | 'suggestions' | 'reviews' | 'settings';
export type CostInsightOwnerCursor = { ownerType: CostInsightSpendOwner['type']; ownerId: string };

const eventTypesByFilter = {
  alerts: ['anomaly_alert', 'threshold_crossed'],
  suggestions: ['suggestion_created', 'suggestion_dismissed'],
  reviews: ['alert_reviewed'],
  settings: ['config_changed', 'disabled'],
} satisfies Record<Exclude<CostInsightEventFilter, 'all'>, CostInsightEventType[]>;

function eventTypesForFilter(filter: CostInsightEventFilter): CostInsightEventType[] | null {
  return filter === 'all' ? null : eventTypesByFilter[filter];
}

export type CostInsightThresholdAlertKind = Extract<
  CostInsightAlertKind,
  'threshold' | 'threshold_7d' | 'threshold_30d'
>;

export type CostInsightConfigPatch = {
  spendAlertsEnabled?: boolean;
  anomalyAlertsEnabled?: boolean;
  costSuggestionsEnabled?: boolean;
  spendThresholdMicrodollars?: number | null;
  spend7DayThresholdMicrodollars?: number | null;
  spend30DayThresholdMicrodollars?: number | null;
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

export function parsePersistedCostInsightEventSnapshot(
  value: unknown
): CostInsightEventSnapshot | null {
  const result = CostInsightEventSnapshotSchema.safeParse(value);
  return result.success ? result.data : null;
}

function validateCostInsightEventSnapshot(value: unknown): CostInsightEventSnapshot {
  return CostInsightEventSnapshotSchema.parse(value);
}

type CostInsightEventWriter = (
  database: CostInsightDatabase,
  input: CostInsightEventInput
) => Promise<{ id: string; created: boolean }>;

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
      anomaly_alerts_enabled: patch.anomalyAlertsEnabled ?? previous.anomaly_alerts_enabled,
      cost_suggestions_enabled: patch.costSuggestionsEnabled ?? previous.cost_suggestions_enabled,
      spend_threshold_microdollars:
        patch.spendThresholdMicrodollars === undefined
          ? previous.spend_threshold_microdollars
          : patch.spendThresholdMicrodollars,
      spend_7_day_threshold_microdollars:
        patch.spend7DayThresholdMicrodollars === undefined
          ? previous.spend_7_day_threshold_microdollars
          : patch.spend7DayThresholdMicrodollars,
      spend_30_day_threshold_microdollars:
        patch.spend30DayThresholdMicrodollars === undefined
          ? previous.spend_30_day_threshold_microdollars
          : patch.spend30DayThresholdMicrodollars,
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

export function getCostInsightConfigChanges(
  previous: CostInsightOwnerConfig,
  current: CostInsightOwnerConfig
): Record<string, { old: unknown; new: unknown }> {
  const fields: Record<string, { old: unknown; new: unknown }> = {};
  const addChange = (key: string, oldValue: unknown, newValue: unknown) => {
    if (oldValue !== newValue) fields[key] = { old: oldValue, new: newValue };
  };

  addChange('spendAlertsEnabled', previous.spend_alerts_enabled, current.spend_alerts_enabled);
  addChange(
    'anomalyAlertsEnabled',
    previous.anomaly_alerts_enabled,
    current.anomaly_alerts_enabled
  );
  addChange(
    'costSuggestionsEnabled',
    previous.cost_suggestions_enabled,
    current.cost_suggestions_enabled
  );
  addChange(
    'spendThresholdMicrodollars',
    previous.spend_threshold_microdollars,
    current.spend_threshold_microdollars
  );
  addChange(
    'spend7DayThresholdMicrodollars',
    previous.spend_7_day_threshold_microdollars,
    current.spend_7_day_threshold_microdollars
  );
  addChange(
    'spend30DayThresholdMicrodollars',
    previous.spend_30_day_threshold_microdollars,
    current.spend_30_day_threshold_microdollars
  );
  return fields;
}

export function getCostInsightSettingsSnapshot(config: CostInsightOwnerConfig) {
  return {
    spendAlertsEnabled: config.spend_alerts_enabled,
    anomalyAlertsEnabled: config.anomaly_alerts_enabled,
    costSuggestionsEnabled: config.cost_suggestions_enabled,
    spendThresholdMicrodollars: config.spend_threshold_microdollars,
    spend7DayThresholdMicrodollars: config.spend_7_day_threshold_microdollars,
    spend30DayThresholdMicrodollars: config.spend_30_day_threshold_microdollars,
  };
}

export async function updateCostInsightSettings(
  database: CostInsightRootDatabase,
  params: {
    owner: CostInsightSpendOwner;
    actorUserId: string;
    patch: CostInsightConfigPatch;
  }
): Promise<{
  previous: CostInsightOwnerConfig;
  current: CostInsightOwnerConfig;
  hasChanges: boolean;
}> {
  return await database.transaction(async transaction => {
    const { previous, current } = await updateCostInsightOwnerConfig(
      transaction,
      params.owner,
      params.patch
    );
    const changes = getCostInsightConfigChanges(previous, current);
    const hasChanges = Object.keys(changes).length > 0;
    const disabled = hasChanges && previous.spend_alerts_enabled && !current.spend_alerts_enabled;

    if (disabled) {
      await clearCostInsightAlertState(transaction, params.owner);
    } else {
      if (previous.anomaly_alerts_enabled && !current.anomaly_alerts_enabled) {
        await clearCostInsightAnomalyEpisode(transaction, params.owner);
      }
      if (
        previous.spend_threshold_microdollars !== null &&
        current.spend_threshold_microdollars === null
      ) {
        await clearCostInsightThresholdEpisode(transaction, params.owner, null, 'threshold');
      }
      if (
        previous.spend_7_day_threshold_microdollars !== null &&
        current.spend_7_day_threshold_microdollars === null
      ) {
        await clearCostInsightThresholdEpisode(transaction, params.owner, null, 'threshold_7d');
      }
      if (
        previous.spend_30_day_threshold_microdollars !== null &&
        current.spend_30_day_threshold_microdollars === null
      ) {
        await clearCostInsightThresholdEpisode(transaction, params.owner, null, 'threshold_30d');
      }
    }

    if (disabled) {
      await createCostInsightEvent(transaction, {
        owner: params.owner,
        eventType: 'disabled',
        actorUserId: params.actorUserId,
        title: 'Spend Alerts turned off',
        description: 'Spend Alerts were disabled. Cost evidence remains visible.',
        snapshot: {
          changedFields: changes,
          settings: getCostInsightSettingsSnapshot(current),
        },
      });
    } else if (hasChanges && (previous.spend_alerts_enabled || current.spend_alerts_enabled)) {
      await createCostInsightEvent(transaction, {
        owner: params.owner,
        eventType: 'config_changed',
        actorUserId: params.actorUserId,
        title: 'Cost Insights settings changed',
        description: 'Spend Alert settings were updated.',
        snapshot: {
          changedFields: changes,
          settings: getCostInsightSettingsSnapshot(current),
        },
      });
    }

    return { previous, current, hasChanges };
  });
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
      active_anomaly_episode_id: null,
      active_anomaly_hour_start: null,
      active_anomaly_snapshot: null,
      active_anomaly_reviewed_at: null,
      threshold_crossing_active: false,
      active_threshold_event_id: null,
      active_threshold_episode_id: null,
      threshold_crossing_started_at: null,
      active_threshold_snapshot: null,
      threshold_reviewed_at: null,
      threshold_recovered_at: null,
      rolling_7_day_threshold_crossing_active: false,
      active_rolling_7_day_threshold_event_id: null,
      active_rolling_7_day_threshold_episode_id: null,
      rolling_7_day_threshold_crossing_started_at: null,
      active_rolling_7_day_threshold_snapshot: null,
      rolling_7_day_threshold_reviewed_at: null,
      rolling_7_day_threshold_recovered_at: null,
      rolling_30_day_threshold_crossing_active: false,
      active_rolling_30_day_threshold_event_id: null,
      active_rolling_30_day_threshold_episode_id: null,
      rolling_30_day_threshold_crossing_started_at: null,
      active_rolling_30_day_threshold_snapshot: null,
      rolling_30_day_threshold_reviewed_at: null,
      rolling_30_day_threshold_recovered_at: null,
      updated_at: sql`now()`,
    })
    .where(eq(cost_insight_owner_states.id, state.id));
}

export async function clearCostInsightAnomalyEpisode(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner
): Promise<void> {
  const state = await getOrCreateCostInsightOwnerState(database, owner);
  await database
    .update(cost_insight_owner_states)
    .set({
      active_anomaly_event_id: null,
      active_anomaly_episode_id: null,
      active_anomaly_hour_start: null,
      active_anomaly_snapshot: null,
      active_anomaly_reviewed_at: null,
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
  const snapshot = validateCostInsightEventSnapshot(input.snapshot ?? {});
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
      snapshot,
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
  if (owner.type === 'user') {
    const [admin] = await database
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(and(eq(kilocode_users.id, owner.id), eq(kilocode_users.is_admin, true)))
      .limit(1);
    return admin ? [admin.id] : [];
  }

  const rows = await database
    .select({ userId: organization_memberships.kilo_user_id })
    .from(organization_memberships)
    .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
    .where(
      and(
        eq(organization_memberships.organization_id, owner.id),
        inArray(organization_memberships.role, ['owner', 'billing_manager']),
        eq(kilocode_users.is_admin, true)
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

type EnabledCostInsightOwnerRow = {
  owner_type: CostInsightSpendOwner['type'];
  owner_id: string;
};

export async function listEnabledCostInsightOwnerPage(
  database: CostInsightDatabase,
  options: {
    cohortCreatedBefore: string;
    after?: CostInsightOwnerCursor | null;
    limit: number;
  }
): Promise<{
  owners: CostInsightSpendOwner[];
  nextCursor: CostInsightOwnerCursor | null;
  hasMore: boolean;
}> {
  if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
    throw new Error('Cost Insights owner page limit must be a positive safe integer.');
  }
  const afterPredicate = options.after
    ? sql`(owner_type, owner_id) > (${options.after.ownerType}, ${options.after.ownerId})`
    : sql`TRUE`;
  const result = await database.execute<EnabledCostInsightOwnerRow>(sql`
    WITH active_owners AS (
      SELECT 'organization'::text AS owner_type, owned_by_organization_id::text AS owner_id
      FROM cost_insight_owner_configs
      WHERE owned_by_organization_id IS NOT NULL
        AND created_at < ${options.cohortCreatedBefore}
        AND (spend_alerts_enabled = TRUE OR cost_suggestions_enabled = TRUE)
      UNION ALL
      SELECT 'user'::text AS owner_type, owned_by_user_id AS owner_id
      FROM cost_insight_owner_configs
      WHERE owned_by_user_id IS NOT NULL
        AND created_at < ${options.cohortCreatedBefore}
        AND (spend_alerts_enabled = TRUE OR cost_suggestions_enabled = TRUE)
    )
    SELECT owner_type, owner_id
    FROM active_owners
    WHERE ${afterPredicate}
    ORDER BY owner_type ASC, owner_id ASC
    LIMIT ${options.limit + 1}
  `);
  const pageRows = result.rows.slice(0, options.limit);
  const owners = pageRows.map(row => ({ type: row.owner_type, id: row.owner_id }));
  const last = pageRows.at(-1);
  return {
    owners,
    nextCursor: last
      ? { ownerType: last.owner_type, ownerId: last.owner_id }
      : (options.after ?? null),
    hasMore: result.rows.length > options.limit,
  };
}

export async function listCostInsightEvents(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner,
  options: { limit?: number; offset?: number; filter?: CostInsightEventFilter } = {}
) {
  const eventTypes = eventTypesForFilter(options.filter ?? 'all');
  const rows = await database
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
    .where(
      and(
        costInsightOwnerWhere(owner, cost_insight_events),
        eventTypes ? inArray(cost_insight_events.event_type, eventTypes) : undefined
      )
    )
    .orderBy(desc(cost_insight_events.occurred_at), desc(cost_insight_events.id))
    .limit(options.limit ?? 50)
    .offset(options.offset ?? 0);
  return rows.map(row => ({
    ...row,
    snapshot: parsePersistedCostInsightEventSnapshot(row.snapshot) ?? {},
  }));
}

export async function countCostInsightEvents(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner,
  filter: CostInsightEventFilter = 'all'
): Promise<number> {
  const eventTypes = eventTypesForFilter(filter);
  const [row] = await database
    .select({ value: count() })
    .from(cost_insight_events)
    .where(
      and(
        costInsightOwnerWhere(owner, cost_insight_events),
        eventTypes ? inArray(cost_insight_events.event_type, eventTypes) : undefined
      )
    );
  return row?.value ?? 0;
}

export async function getCostInsightDashboardState(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner
) {
  const [state] = await database
    .select({
      activeAnomalyEventId: cost_insight_owner_states.active_anomaly_event_id,
      activeAnomalyEpisodeId: cost_insight_owner_states.active_anomaly_episode_id,
      activeAnomalyHourStart: cost_insight_owner_states.active_anomaly_hour_start,
      activeAnomalySnapshot: cost_insight_owner_states.active_anomaly_snapshot,
      activeAnomalyReviewedAt: cost_insight_owner_states.active_anomaly_reviewed_at,
      activeThresholdEventId: cost_insight_owner_states.active_threshold_event_id,
      activeThresholdEpisodeId: cost_insight_owner_states.active_threshold_episode_id,
      thresholdCrossingActive: cost_insight_owner_states.threshold_crossing_active,
      activeThresholdSnapshot: cost_insight_owner_states.active_threshold_snapshot,
      thresholdReviewedAt: cost_insight_owner_states.threshold_reviewed_at,
      active7DayThresholdEventId: cost_insight_owner_states.active_rolling_7_day_threshold_event_id,
      active7DayThresholdEpisodeId:
        cost_insight_owner_states.active_rolling_7_day_threshold_episode_id,
      threshold7DayCrossingActive:
        cost_insight_owner_states.rolling_7_day_threshold_crossing_active,
      active7DayThresholdSnapshot:
        cost_insight_owner_states.active_rolling_7_day_threshold_snapshot,
      threshold7DayReviewedAt: cost_insight_owner_states.rolling_7_day_threshold_reviewed_at,
      active30DayThresholdEventId:
        cost_insight_owner_states.active_rolling_30_day_threshold_event_id,
      active30DayThresholdEpisodeId:
        cost_insight_owner_states.active_rolling_30_day_threshold_episode_id,
      threshold30DayCrossingActive:
        cost_insight_owner_states.rolling_30_day_threshold_crossing_active,
      active30DayThresholdSnapshot:
        cost_insight_owner_states.active_rolling_30_day_threshold_snapshot,
      threshold30DayReviewedAt: cost_insight_owner_states.rolling_30_day_threshold_reviewed_at,
      lastEvaluatedAt: cost_insight_owner_states.last_evaluated_at,
    })
    .from(cost_insight_owner_states)
    .where(costInsightOwnerWhere(owner, cost_insight_owner_states))
    .limit(1);

  const eventIds = [
    state?.activeAnomalyEventId,
    state?.activeThresholdEventId,
    state?.active7DayThresholdEventId,
    state?.active30DayThresholdEventId,
  ].filter((id): id is string => Boolean(id));

  const events =
    eventIds.length === 0
      ? []
      : await database
          .select({
            id: cost_insight_events.id,
            event_type: cost_insight_events.event_type,
            alert_kind: cost_insight_events.alert_kind,
            snapshot: cost_insight_events.snapshot,
          })
          .from(cost_insight_events)
          .where(inArray(cost_insight_events.id, eventIds));

  const eventsById = new Map(
    events.map(event => [
      event.id,
      { ...event, snapshot: parsePersistedCostInsightEventSnapshot(event.snapshot) ?? {} },
    ])
  );
  const activeAnomalyEpisodeId = state?.activeAnomalyEpisodeId ?? state?.activeAnomalyEventId;
  if (activeAnomalyEpisodeId) {
    const parsedSnapshot = parsePersistedCostInsightEventSnapshot(state?.activeAnomalySnapshot);
    if (parsedSnapshot || !eventsById.has(activeAnomalyEpisodeId)) {
      eventsById.set(activeAnomalyEpisodeId, {
        id: activeAnomalyEpisodeId,
        event_type: 'anomaly_alert',
        alert_kind: 'anomaly',
        snapshot: parsedSnapshot ?? {},
      });
    }
  }
  const thresholdSnapshots = [
    {
      id: state?.activeThresholdEpisodeId,
      fallbackId: state?.activeThresholdEventId,
      snapshot: state?.activeThresholdSnapshot,
      alertKind: 'threshold' as const,
    },
    {
      id: state?.active7DayThresholdEpisodeId,
      fallbackId: state?.active7DayThresholdEventId,
      snapshot: state?.active7DayThresholdSnapshot,
      alertKind: 'threshold_7d' as const,
    },
    {
      id: state?.active30DayThresholdEpisodeId,
      fallbackId: state?.active30DayThresholdEventId,
      snapshot: state?.active30DayThresholdSnapshot,
      alertKind: 'threshold_30d' as const,
    },
  ];
  for (const threshold of thresholdSnapshots) {
    const episodeId = threshold.id ?? threshold.fallbackId;
    if (!episodeId) continue;
    const parsedSnapshot = parsePersistedCostInsightEventSnapshot(threshold.snapshot);
    if (parsedSnapshot || !eventsById.has(episodeId)) {
      eventsById.set(episodeId, {
        id: episodeId,
        event_type: 'threshold_crossed',
        alert_kind: threshold.alertKind,
        snapshot: parsedSnapshot ?? {},
      });
    }
  }

  return { state: state ?? null, events: [...eventsById.values()] };
}

export async function markCostInsightAnomalyEpisode(
  database: CostInsightDatabase,
  params: {
    owner: CostInsightSpendOwner;
    eventId: string;
    hourStart: string;
    snapshot: CostInsightEventSnapshot;
  }
): Promise<void> {
  const snapshot = validateCostInsightEventSnapshot(params.snapshot);
  const state = await getOrCreateCostInsightOwnerState(database, params.owner);
  await database
    .update(cost_insight_owner_states)
    .set({
      active_anomaly_event_id: params.eventId,
      active_anomaly_episode_id: params.eventId,
      active_anomaly_hour_start: params.hourStart,
      active_anomaly_snapshot: snapshot,
      active_anomaly_reviewed_at: null,
      updated_at: sql`now()`,
    })
    .where(eq(cost_insight_owner_states.id, state.id));
}

export async function markCostInsightThresholdEpisode(
  database: CostInsightDatabase,
  params: {
    owner: CostInsightSpendOwner;
    eventId: string;
    crossedAt: string;
    alertKind: CostInsightThresholdAlertKind;
    snapshot: CostInsightEventSnapshot;
  }
): Promise<void> {
  const snapshot = validateCostInsightEventSnapshot(params.snapshot);
  const state = await getOrCreateCostInsightOwnerState(database, params.owner);
  const values = (() => {
    if (params.alertKind === 'threshold_7d') {
      return {
        rolling_7_day_threshold_crossing_active: true,
        active_rolling_7_day_threshold_event_id: params.eventId,
        active_rolling_7_day_threshold_episode_id: params.eventId,
        rolling_7_day_threshold_crossing_started_at: params.crossedAt,
        active_rolling_7_day_threshold_snapshot: snapshot,
        rolling_7_day_threshold_reviewed_at: null,
        rolling_7_day_threshold_recovered_at: null,
        updated_at: sql`now()`,
      };
    }
    if (params.alertKind === 'threshold_30d') {
      return {
        rolling_30_day_threshold_crossing_active: true,
        active_rolling_30_day_threshold_event_id: params.eventId,
        active_rolling_30_day_threshold_episode_id: params.eventId,
        rolling_30_day_threshold_crossing_started_at: params.crossedAt,
        active_rolling_30_day_threshold_snapshot: snapshot,
        rolling_30_day_threshold_reviewed_at: null,
        rolling_30_day_threshold_recovered_at: null,
        updated_at: sql`now()`,
      };
    }
    return {
      threshold_crossing_active: true,
      active_threshold_event_id: params.eventId,
      active_threshold_episode_id: params.eventId,
      threshold_crossing_started_at: params.crossedAt,
      active_threshold_snapshot: snapshot,
      threshold_reviewed_at: null,
      threshold_recovered_at: null,
      updated_at: sql`now()`,
    };
  })();
  await database
    .update(cost_insight_owner_states)
    .set(values)
    .where(eq(cost_insight_owner_states.id, state.id));
}

export async function clearCostInsightThresholdEpisode(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner,
  recoveredAt: string | null,
  alertKind: CostInsightThresholdAlertKind = 'threshold'
): Promise<void> {
  const state = await getOrCreateCostInsightOwnerState(database, owner);
  const values = (() => {
    if (alertKind === 'threshold_7d') {
      return {
        rolling_7_day_threshold_crossing_active: false,
        active_rolling_7_day_threshold_event_id: null,
        active_rolling_7_day_threshold_episode_id: null,
        rolling_7_day_threshold_crossing_started_at: null,
        active_rolling_7_day_threshold_snapshot: null,
        rolling_7_day_threshold_reviewed_at: null,
        rolling_7_day_threshold_recovered_at: recoveredAt,
        updated_at: sql`now()`,
      };
    }
    if (alertKind === 'threshold_30d') {
      return {
        rolling_30_day_threshold_crossing_active: false,
        active_rolling_30_day_threshold_event_id: null,
        active_rolling_30_day_threshold_episode_id: null,
        rolling_30_day_threshold_crossing_started_at: null,
        active_rolling_30_day_threshold_snapshot: null,
        rolling_30_day_threshold_reviewed_at: null,
        rolling_30_day_threshold_recovered_at: recoveredAt,
        updated_at: sql`now()`,
      };
    }
    return {
      threshold_crossing_active: false,
      active_threshold_event_id: null,
      active_threshold_episode_id: null,
      threshold_crossing_started_at: null,
      active_threshold_snapshot: null,
      threshold_reviewed_at: null,
      threshold_recovered_at: recoveredAt,
      updated_at: sql`now()`,
    };
  })();
  await database
    .update(cost_insight_owner_states)
    .set(values)
    .where(eq(cost_insight_owner_states.id, state.id));
}

async function acknowledgeCostInsightAlertInTransaction(
  database: CostInsightDatabase,
  params: {
    owner: CostInsightSpendOwner;
    alertKind: CostInsightAlertKind;
    eventId: string;
    actorUserId: string;
  },
  writeEvent: CostInsightEventWriter
): Promise<boolean> {
  const state = await getOrCreateCostInsightOwnerState(database, params.owner);
  const now = sql`now()`;
  const reviewValues =
    params.alertKind === 'anomaly'
      ? { active_anomaly_reviewed_at: now, updated_at: now }
      : params.alertKind === 'threshold_7d'
        ? { rolling_7_day_threshold_reviewed_at: now, updated_at: now }
        : params.alertKind === 'threshold_30d'
          ? { rolling_30_day_threshold_reviewed_at: now, updated_at: now }
          : { threshold_reviewed_at: now, updated_at: now };
  const activeEpisode =
    params.alertKind === 'anomaly'
      ? and(
          sql`COALESCE(${cost_insight_owner_states.active_anomaly_episode_id}, ${cost_insight_owner_states.active_anomaly_event_id}) = ${params.eventId}`,
          isNull(cost_insight_owner_states.active_anomaly_reviewed_at)
        )
      : params.alertKind === 'threshold_7d'
        ? and(
            sql`COALESCE(${cost_insight_owner_states.active_rolling_7_day_threshold_episode_id}, ${cost_insight_owner_states.active_rolling_7_day_threshold_event_id}) = ${params.eventId}`,
            isNull(cost_insight_owner_states.rolling_7_day_threshold_reviewed_at)
          )
        : params.alertKind === 'threshold_30d'
          ? and(
              sql`COALESCE(${cost_insight_owner_states.active_rolling_30_day_threshold_episode_id}, ${cost_insight_owner_states.active_rolling_30_day_threshold_event_id}) = ${params.eventId}`,
              isNull(cost_insight_owner_states.rolling_30_day_threshold_reviewed_at)
            )
          : and(
              sql`COALESCE(${cost_insight_owner_states.active_threshold_episode_id}, ${cost_insight_owner_states.active_threshold_event_id}) = ${params.eventId}`,
              isNull(cost_insight_owner_states.threshold_reviewed_at)
            );
  const [acknowledged] = await database
    .update(cost_insight_owner_states)
    .set(reviewValues)
    .where(and(eq(cost_insight_owner_states.id, state.id), activeEpisode))
    .returning({ id: cost_insight_owner_states.id });

  if (!acknowledged) return false;

  await writeEvent(database, {
    owner: params.owner,
    eventType: 'alert_reviewed',
    alertKind: params.alertKind,
    actorUserId: params.actorUserId,
    title:
      params.alertKind === 'anomaly'
        ? 'Spend Anomaly Alert reviewed'
        : params.alertKind === 'threshold_7d'
          ? '7-day Spend Threshold Alert reviewed'
          : params.alertKind === 'threshold_30d'
            ? '30-day Spend Threshold Alert reviewed'
            : '24-hour Spend Threshold Alert reviewed',
    description: 'Alert acknowledgment recorded for the current episode.',
    dedupeKey: `alert-reviewed:${params.eventId}`,
  });
  return true;
}

export async function acknowledgeCostInsightAlert(
  database: CostInsightRootDatabase,
  params: {
    owner: CostInsightSpendOwner;
    alertKind: CostInsightAlertKind;
    eventId: string;
    actorUserId: string;
  }
): Promise<boolean> {
  return await database.transaction(async transaction =>
    acknowledgeCostInsightAlertInTransaction(transaction, params, createCostInsightEvent)
  );
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

async function dismissCostInsightSuggestionInTransaction(
  database: CostInsightDatabase,
  params: { owner: CostInsightSpendOwner; suggestionId: string; actorUserId: string },
  writeEvent: CostInsightEventWriter
): Promise<CostInsightSuggestionKind | null> {
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

  if (!suggestion) return null;
  await writeEvent(database, {
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
    dedupeKey: `suggestion-dismissed:${suggestion.id}`,
  });
  return suggestion.suggestion_kind;
}

export async function dismissCostInsightSuggestion(
  database: CostInsightRootDatabase,
  params: { owner: CostInsightSpendOwner; suggestionId: string; actorUserId: string }
): Promise<CostInsightSuggestionKind | null> {
  return await database.transaction(async transaction =>
    dismissCostInsightSuggestionInTransaction(transaction, params, createCostInsightEvent)
  );
}

export async function hasCurrentCostInsightAccess(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner,
  userId: string
): Promise<boolean> {
  if (owner.type === 'user') {
    if (owner.id !== userId) return false;
    const [admin] = await database
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(and(eq(kilocode_users.id, userId), eq(kilocode_users.is_admin, true)))
      .limit(1);
    return Boolean(admin);
  }
  const [row] = await database
    .select({ id: organization_memberships.id })
    .from(organization_memberships)
    .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
    .where(
      and(
        eq(organization_memberships.organization_id, owner.id),
        eq(organization_memberships.kilo_user_id, userId),
        inArray(organization_memberships.role, ['owner', 'billing_manager']),
        eq(kilocode_users.is_admin, true)
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
            sql`COALESCE(${cost_insight_owner_states.active_anomaly_episode_id}, ${cost_insight_owner_states.active_anomaly_event_id}) IS NOT NULL`
          ),
          and(
            isNull(cost_insight_owner_states.threshold_reviewed_at),
            sql`COALESCE(${cost_insight_owner_states.active_threshold_episode_id}, ${cost_insight_owner_states.active_threshold_event_id}) IS NOT NULL`
          ),
          and(
            isNull(cost_insight_owner_states.rolling_7_day_threshold_reviewed_at),
            sql`COALESCE(${cost_insight_owner_states.active_rolling_7_day_threshold_episode_id}, ${cost_insight_owner_states.active_rolling_7_day_threshold_event_id}) IS NOT NULL`
          ),
          and(
            isNull(cost_insight_owner_states.rolling_30_day_threshold_reviewed_at),
            sql`COALESCE(${cost_insight_owner_states.active_rolling_30_day_threshold_episode_id}, ${cost_insight_owner_states.active_rolling_30_day_threshold_event_id}) IS NOT NULL`
          )
        )
      )
    )
    .limit(1);
  return Boolean(row);
}

export async function countUnreviewedCostInsightAlerts(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner
): Promise<number> {
  const [state] = await database
    .select({
      activeAnomalyEpisodeId: cost_insight_owner_states.active_anomaly_episode_id,
      activeAnomalyEventId: cost_insight_owner_states.active_anomaly_event_id,
      activeAnomalyReviewedAt: cost_insight_owner_states.active_anomaly_reviewed_at,
      activeThresholdEpisodeId: cost_insight_owner_states.active_threshold_episode_id,
      activeThresholdEventId: cost_insight_owner_states.active_threshold_event_id,
      thresholdReviewedAt: cost_insight_owner_states.threshold_reviewed_at,
      active7DayThresholdEpisodeId:
        cost_insight_owner_states.active_rolling_7_day_threshold_episode_id,
      active7DayThresholdEventId: cost_insight_owner_states.active_rolling_7_day_threshold_event_id,
      threshold7DayReviewedAt: cost_insight_owner_states.rolling_7_day_threshold_reviewed_at,
      active30DayThresholdEpisodeId:
        cost_insight_owner_states.active_rolling_30_day_threshold_episode_id,
      active30DayThresholdEventId:
        cost_insight_owner_states.active_rolling_30_day_threshold_event_id,
      threshold30DayReviewedAt: cost_insight_owner_states.rolling_30_day_threshold_reviewed_at,
    })
    .from(cost_insight_owner_states)
    .where(costInsightOwnerWhere(owner, cost_insight_owner_states))
    .limit(1);

  return (
    ((state?.activeAnomalyEpisodeId ?? state?.activeAnomalyEventId) &&
    !state.activeAnomalyReviewedAt
      ? 1
      : 0) +
    ((state?.activeThresholdEpisodeId ?? state?.activeThresholdEventId) &&
    !state.thresholdReviewedAt
      ? 1
      : 0) +
    ((state?.active7DayThresholdEpisodeId ?? state?.active7DayThresholdEventId) &&
    !state.threshold7DayReviewedAt
      ? 1
      : 0) +
    ((state?.active30DayThresholdEpisodeId ?? state?.active30DayThresholdEventId) &&
    !state.threshold30DayReviewedAt
      ? 1
      : 0)
  );
}

export async function countOpenCostInsightReviewItems(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner
): Promise<number> {
  const alertCount = await countUnreviewedCostInsightAlerts(database, owner);
  const [config] = await database
    .select({ costSuggestionsEnabled: cost_insight_owner_configs.cost_suggestions_enabled })
    .from(cost_insight_owner_configs)
    .where(costInsightOwnerWhere(owner, cost_insight_owner_configs))
    .limit(1);

  if (config?.costSuggestionsEnabled === false) return alertCount;

  const [suggestions] = await database
    .select({ value: count() })
    .from(cost_insight_active_suggestions)
    .where(
      and(
        costInsightOwnerWhere(owner, cost_insight_active_suggestions),
        isNull(cost_insight_active_suggestions.dismissed_at)
      )
    );

  return alertCount + (suggestions?.value ?? 0);
}

export const costInsightRepositoryInternals = {
  acknowledgeCostInsightAlertInTransaction,
  dismissCostInsightSuggestionInTransaction,
};
