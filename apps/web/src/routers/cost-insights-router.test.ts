import { jest } from '@jest/globals';
import {
  cost_insight_active_suggestions,
  cost_insight_events,
  cost_insight_owner_configs,
  cost_insight_owner_states,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import type { createCallerForUser as CreateCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';

jest.mock('@/lib/cost-insights/posthog-tracking', () => ({
  trackCostInsightsAlertAction: jest.fn(),
  trackCostInsightsSettingsSaved: jest.fn(),
  trackCostInsightsSuggestionAction: jest.fn(),
  trackCostInsightsUiInteraction: jest.fn(),
}));

const trackingMock: {
  trackCostInsightsAlertAction: jest.Mock;
  trackCostInsightsSettingsSaved: jest.Mock;
  trackCostInsightsSuggestionAction: jest.Mock;
  trackCostInsightsUiInteraction: jest.Mock;
} = jest.requireMock('@/lib/cost-insights/posthog-tracking');

let createCallerForUser: typeof CreateCallerForUser;

beforeAll(async () => {
  ({ createCallerForUser } = await import('@/routers/test-utils'));
});

describe('Cost Insights router', () => {
  beforeEach(() => {
    trackingMock.trackCostInsightsAlertAction.mockClear();
    trackingMock.trackCostInsightsSettingsSaved.mockClear();
    trackingMock.trackCostInsightsSuggestionAction.mockClear();
    trackingMock.trackCostInsightsUiInteraction.mockClear();
  });

  it('rejects every Cost Insights procedure for non-admin users', async () => {
    const user = await insertTestUser();
    const caller = await createCallerForUser(user.id);
    const calls = [
      () =>
        caller.costInsights.trackUiInteraction({
          interaction: 'spend_range_selected' as const,
          range: '24h' as const,
        }),
      () =>
        caller.costInsights.trackSuggestionCta({
          suggestionKind: 'kilo_pass' as const,
        }),
      () => caller.costInsights.getDashboard(),
      () => caller.costInsights.getSettings(),
      () => caller.costInsights.listEvents({ filter: 'all', page: 1, pageSize: 10 }),
      () => caller.costInsights.getAttentionState(),
      () =>
        caller.costInsights.updateSettings({
          spendAlertsEnabled: false,
          anomalyAlertsEnabled: true,
          costSuggestionsEnabled: true,
          spendThresholdUsd: null,
          spend7DayThresholdUsd: null,
          spend30DayThresholdUsd: null,
        }),
      () => caller.costInsights.acknowledgeAlert({ alertKind: 'anomaly' }),
      () => caller.costInsights.disableThreshold(),
      () => caller.costInsights.dismissSuggestion({ suggestionId: crypto.randomUUID() }),
    ];

    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Admin access required',
      });
    }
  });

  it('tracks allowlisted UI interactions with authenticated personal context', async () => {
    const user = await insertTestUser({ is_admin: true });
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.costInsights.trackUiInteraction({
        interaction: 'spend_range_selected',
        range: '90d',
      })
    ).resolves.toEqual({ success: true });
    expect(trackingMock.trackCostInsightsUiInteraction).toHaveBeenCalledWith(
      {
        distinctId: user.id,
        userId: user.id,
        ownerType: 'personal',
        authorizedRole: 'personal',
      },
      { interaction: 'spend_range_selected', range: '90d' }
    );

    await expect(
      caller.costInsights.trackUiInteraction({
        interaction: 'ask_kilo_question_submitted',
        source: 'follow_up',
        experience: 'ui_only',
        question: 'private question',
      } as never)
    ).rejects.toThrow();
    expect(trackingMock.trackCostInsightsUiInteraction).toHaveBeenCalledTimes(1);
  });

  it('counts open alerts and suggestions for sidebar review badge', async () => {
    const user = await insertTestUser({ is_admin: true });
    await db.insert(cost_insight_owner_configs).values({
      owned_by_user_id: user.id,
      spend_alerts_enabled: true,
      cost_suggestions_enabled: true,
    });
    const [anomalyEvent, thresholdEvent, threshold7DayEvent, threshold30DayEvent] = await db
      .insert(cost_insight_events)
      .values([
        {
          owned_by_user_id: user.id,
          event_type: 'anomaly_alert',
          alert_kind: 'anomaly',
          title: 'Spend Anomaly Alert',
          description: 'Usage-based spend is high.',
        },
        {
          owned_by_user_id: user.id,
          event_type: 'threshold_crossed',
          alert_kind: 'threshold',
          title: '24-hour Spend Threshold Alert',
          description: 'Rolling 24-hour spend crossed threshold.',
        },
        {
          owned_by_user_id: user.id,
          event_type: 'threshold_crossed',
          alert_kind: 'threshold_7d',
          title: '7-day Spend Threshold Alert',
          description: 'Rolling 7-day spend crossed threshold.',
        },
        {
          owned_by_user_id: user.id,
          event_type: 'threshold_crossed',
          alert_kind: 'threshold_30d',
          title: '30-day Spend Threshold Alert',
          description: 'Rolling 30-day spend crossed threshold.',
        },
      ])
      .returning({ id: cost_insight_events.id });
    if (!anomalyEvent || !thresholdEvent || !threshold7DayEvent || !threshold30DayEvent) {
      throw new Error('Cost Insights alert event fixture insert failed.');
    }
    await db.insert(cost_insight_owner_states).values({
      owned_by_user_id: user.id,
      active_anomaly_event_id: anomalyEvent.id,
      active_threshold_event_id: thresholdEvent.id,
      threshold_crossing_active: true,
      threshold_crossing_started_at: '2026-06-25T19:00:00.000Z',
      active_rolling_7_day_threshold_event_id: threshold7DayEvent.id,
      rolling_7_day_threshold_crossing_active: true,
      rolling_7_day_threshold_crossing_started_at: '2026-06-25T19:00:00.000Z',
      active_rolling_30_day_threshold_event_id: threshold30DayEvent.id,
      rolling_30_day_threshold_crossing_active: true,
      rolling_30_day_threshold_crossing_started_at: '2026-06-25T19:00:00.000Z',
    });
    await db.insert(cost_insight_active_suggestions).values({
      owned_by_user_id: user.id,
      suggestion_kind: 'kilo_pass',
      suggestion_key: 'a'.repeat(64),
      title: 'Review Kilo Pass coverage',
      description: 'Kilo Pass may improve cost efficiency.',
      cta_label: 'View Kilo Pass',
      cta_href: '/subscriptions/kilo-pass',
      evidence_window_start: '2026-06-18T19:00:00.000Z',
      evidence_window_end: '2026-06-25T19:00:00.000Z',
      observed_microdollars: 125_000_000,
      benefit_label: 'Expert plan',
      benefit_detail: '$199 + bonus credits',
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.costInsights.getAttentionState()).resolves.toEqual({
      attention: 'alert',
      reviewItemCount: 5,
    });

    await db
      .update(cost_insight_owner_configs)
      .set({ cost_suggestions_enabled: false })
      .where(eq(cost_insight_owner_configs.owned_by_user_id, user.id));

    await expect(caller.costInsights.getAttentionState()).resolves.toEqual({
      attention: 'alert',
      reviewItemCount: 4,
    });
  });

  it('defaults anomaly alerts on and saves all spend thresholds as sub-options', async () => {
    const user = await insertTestUser({ is_admin: true });
    const caller = await createCallerForUser(user.id);

    await expect(caller.costInsights.getSettings()).resolves.toMatchObject({
      enabled: false,
      anomalyAlertsEnabled: true,
      thresholdUsd: '',
      threshold7DayUsd: '',
      threshold30DayUsd: '',
    });

    const [anomalyEvent] = await db
      .insert(cost_insight_events)
      .values({
        owned_by_user_id: user.id,
        event_type: 'anomaly_alert',
        alert_kind: 'anomaly',
        title: 'Spend Anomaly Alert',
        description: 'Usage-based spend is high.',
      })
      .returning({ id: cost_insight_events.id });
    if (!anomalyEvent) throw new Error('Cost Insights anomaly event fixture insert failed.');
    await db.insert(cost_insight_owner_states).values({
      owned_by_user_id: user.id,
      active_anomaly_event_id: anomalyEvent.id,
      active_anomaly_hour_start: '2026-06-25T19:00:00.000Z',
    });

    await expect(
      caller.costInsights.updateSettings({
        spendAlertsEnabled: false,
        anomalyAlertsEnabled: false,
        costSuggestionsEnabled: true,
        spendThresholdUsd: '150.00',
        spend7DayThresholdUsd: '500.00',
        spend30DayThresholdUsd: '1000.00',
      })
    ).resolves.toEqual({ success: true });
    expect(trackingMock.trackCostInsightsSettingsSaved).toHaveBeenCalledWith({
      distinctId: user.id,
      userId: user.id,
      ownerType: 'personal',
      authorizedRole: 'personal',
      spendAlertsTransition: 'unchanged',
      anomalyAlertsTransition: 'disabled',
      costSuggestionsTransition: 'unchanged',
      threshold24hTransition: 'added',
      threshold7dTransition: 'added',
      threshold30dTransition: 'added',
      spendAlertsEnabled: false,
      anomalyAlertsEnabled: false,
      costSuggestionsEnabled: true,
      threshold24hConfigured: true,
      threshold7dConfigured: true,
      threshold30dConfigured: true,
    });

    await caller.costInsights.updateSettings({
      spendAlertsEnabled: false,
      anomalyAlertsEnabled: false,
      costSuggestionsEnabled: true,
      spendThresholdUsd: '150.00',
      spend7DayThresholdUsd: '500.00',
      spend30DayThresholdUsd: '1000.00',
    });
    expect(trackingMock.trackCostInsightsSettingsSaved).toHaveBeenCalledTimes(1);

    const [config] = await db
      .select()
      .from(cost_insight_owner_configs)
      .where(eq(cost_insight_owner_configs.owned_by_user_id, user.id));
    const [state] = await db
      .select()
      .from(cost_insight_owner_states)
      .where(eq(cost_insight_owner_states.owned_by_user_id, user.id));

    expect(config).toMatchObject({
      anomaly_alerts_enabled: false,
      spend_threshold_microdollars: 150_000_000,
      spend_7_day_threshold_microdollars: 500_000_000,
      spend_30_day_threshold_microdollars: 1_000_000_000,
    });
    expect(state).toMatchObject({
      active_anomaly_event_id: null,
      active_anomaly_hour_start: null,
      active_anomaly_reviewed_at: null,
    });
  });

  it('turns off the threshold and clears the active threshold episode', async () => {
    const user = await insertTestUser({ is_admin: true });
    await db.insert(cost_insight_owner_configs).values({
      owned_by_user_id: user.id,
      spend_alerts_enabled: true,
      cost_suggestions_enabled: true,
      spend_threshold_microdollars: 150_000_000,
    });
    await db.insert(cost_insight_owner_states).values({
      owned_by_user_id: user.id,
      threshold_crossing_active: true,
      threshold_crossing_started_at: '2026-06-25T19:00:00.000Z',
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.costInsights.disableThreshold()).resolves.toEqual({ success: true });

    const [config] = await db
      .select()
      .from(cost_insight_owner_configs)
      .where(eq(cost_insight_owner_configs.owned_by_user_id, user.id));
    const [state] = await db
      .select()
      .from(cost_insight_owner_states)
      .where(eq(cost_insight_owner_states.owned_by_user_id, user.id));
    const events = await db
      .select()
      .from(cost_insight_events)
      .where(eq(cost_insight_events.owned_by_user_id, user.id));

    expect(config?.spend_threshold_microdollars).toBeNull();
    expect(state).toMatchObject({
      threshold_crossing_active: false,
      active_threshold_event_id: null,
      threshold_crossing_started_at: null,
      threshold_reviewed_at: null,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: 'config_changed',
      actor_user_id: user.id,
      description: 'Spend threshold was turned off.',
      snapshot: {
        changedFields: {
          spendThresholdMicrodollars: { old: 150_000_000, new: null },
        },
        settings: {
          spendAlertsEnabled: true,
          costSuggestionsEnabled: true,
          spendThresholdMicrodollars: null,
        },
      },
    });
  });

  it('tracks accepted alert reviews and suggestion dismissals only once', async () => {
    const user = await insertTestUser({ is_admin: true });
    const [alertEvent] = await db
      .insert(cost_insight_events)
      .values({
        owned_by_user_id: user.id,
        event_type: 'threshold_crossed',
        alert_kind: 'threshold_7d',
        title: '7-day Spend Threshold Alert',
        description: 'Rolling 7-day spend crossed threshold.',
      })
      .returning({ id: cost_insight_events.id });
    if (!alertEvent) throw new Error('Cost Insights alert fixture insert failed.');
    await db.insert(cost_insight_owner_states).values({
      owned_by_user_id: user.id,
      active_rolling_7_day_threshold_event_id: alertEvent.id,
      rolling_7_day_threshold_crossing_active: true,
      rolling_7_day_threshold_crossing_started_at: '2026-06-25T19:00:00.000Z',
    });
    const [suggestion] = await db
      .insert(cost_insight_active_suggestions)
      .values({
        owned_by_user_id: user.id,
        suggestion_kind: 'coding_plan',
        suggestion_key: 'b'.repeat(64),
        title: 'Compare Coding Plans',
        description: 'A Coding Plan may improve cost efficiency.',
        cta_label: 'Compare plans',
        cta_href: '/pricing',
        evidence_window_start: '2026-06-18T19:00:00.000Z',
        evidence_window_end: '2026-06-25T19:00:00.000Z',
        observed_microdollars: 125_000_000,
        benefit_label: 'Included usage',
        benefit_detail: 'Current plan terms apply',
      })
      .returning({ id: cost_insight_active_suggestions.id });
    if (!suggestion) throw new Error('Cost Insights suggestion fixture insert failed.');

    const caller = await createCallerForUser(user.id);
    await caller.costInsights.acknowledgeAlert({ alertKind: 'threshold_7d' });
    await caller.costInsights.acknowledgeAlert({ alertKind: 'threshold_7d' });
    expect(trackingMock.trackCostInsightsAlertAction).toHaveBeenCalledTimes(1);
    expect(trackingMock.trackCostInsightsAlertAction).toHaveBeenCalledWith({
      distinctId: user.id,
      userId: user.id,
      ownerType: 'personal',
      authorizedRole: 'personal',
      action: 'acknowledge',
      alertKind: 'threshold_7d',
    });

    await caller.costInsights.dismissSuggestion({ suggestionId: suggestion.id });
    await caller.costInsights.dismissSuggestion({ suggestionId: suggestion.id });
    expect(trackingMock.trackCostInsightsSuggestionAction).toHaveBeenCalledTimes(1);
    expect(trackingMock.trackCostInsightsSuggestionAction).toHaveBeenCalledWith({
      distinctId: user.id,
      userId: user.id,
      ownerType: 'personal',
      authorizedRole: 'personal',
      action: 'dismiss',
      suggestionKind: 'coding_plan',
      phase: 'accepted',
    });
  });

  it('paginates filtered event history beyond the first 50 rows', async () => {
    const user = await insertTestUser({ is_admin: true });
    await db.insert(cost_insight_events).values(
      Array.from({ length: 62 }, (_, index) => ({
        owned_by_user_id: user.id,
        event_type: 'config_changed' as const,
        title: `Settings event ${index + 1}`,
        description: 'Settings changed.',
        occurred_at: new Date(Date.UTC(2026, 5, 25, 0, index)).toISOString(),
      }))
    );

    const caller = await createCallerForUser(user.id);
    const result = await caller.costInsights.listEvents({
      filter: 'settings',
      page: 7,
      pageSize: 10,
    });

    expect(result).toMatchObject({
      filter: 'settings',
      page: 7,
      pageCount: 7,
      totalCount: 62,
    });
    expect(result.events).toHaveLength(2);
    expect(result.events.map(event => event.title)).toEqual([
      'Settings event 2',
      'Settings event 1',
    ]);
  });
});
