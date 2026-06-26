import type { CostInsightActiveSuggestion } from '@kilocode/db/schema';

import {
  formatActiveCostInsightAlerts,
  formatActiveCostInsightSuggestions,
  formatCostInsightEvents,
  spendRangeStartHour,
} from './presenter';

describe('Cost Insights presenter', () => {
  it('uses matching UTC bucket windows for every selectable spend range', () => {
    const endHourExclusive = '2026-06-26T12:00:00.000Z';

    expect(spendRangeStartHour('1h', endHourExclusive)).toBe('2026-06-26T11:00:00.000Z');
    expect(spendRangeStartHour('24h', endHourExclusive)).toBe('2026-06-25T12:00:00.000Z');
    expect(spendRangeStartHour('7d', endHourExclusive)).toBe('2026-06-19T12:00:00.000Z');
    expect(spendRangeStartHour('30d', endHourExclusive)).toBe('2026-05-27T12:00:00.000Z');
    expect(spendRangeStartHour('90d', endHourExclusive)).toBe('2026-03-28T12:00:00.000Z');
  });

  it('formats active alert cards with Storybook labels, facts, and actions', () => {
    const state = {
      state: {
        activeAnomalyEventId: 'evt-anomaly',
        activeAnomalyHourStart: '2026-06-25T19:00:00.000Z',
        activeAnomalyReviewedAt: null,
        activeThresholdEventId: 'evt-threshold',
        thresholdCrossingActive: true,
        thresholdReviewedAt: null,
        lastEvaluatedAt: '2026-06-25T19:02:00.000Z',
      },
      events: [
        {
          event_type: 'anomaly_alert',
          snapshot: {
            currentHourVariableMicrodollars: 112_700_000,
            anomalyBaselineMicrodollars: 6_000_000,
            anomalyThresholdMicrodollars: 18_000_000,
            topDrivers: [
              {
                spendCategory: 'variable',
                source: 'ai_gateway',
                productKey: 'cli',
                featureKey: 'messages',
                modelOrPlanKey: 'claude-sonnet-4',
                providerKey: 'anthropic',
                actorUserId: null,
                totalMicrodollars: 74_200_000,
                spendRecordCount: 184,
              },
            ],
            topDriversWindow: {
              startInclusive: '2026-06-25T19:00:00.000Z',
              endExclusive: '2026-06-25T20:00:00.000Z',
              spendCategory: 'variable',
            },
          },
        },
        {
          event_type: 'threshold_crossed',
          snapshot: {
            rolling24HourMicrodollars: 184_900_000,
            thresholdMicrodollars: 150_000_000,
            topDrivers: [
              {
                spendCategory: 'scheduled',
                source: 'kiloclaw',
                productKey: 'kiloclaw_hosting',
                featureKey: 'renewal',
                modelOrPlanKey: 'standard',
                providerKey: 'other',
                actorUserId: null,
                totalMicrodollars: 63_900_000,
                spendRecordCount: 1,
              },
            ],
            topDriversWindow: {
              startInclusive: '2026-06-24T19:02:00.000Z',
              endExclusive: '2026-06-25T19:02:00.000Z',
            },
          },
        },
      ],
    } as Parameters<typeof formatActiveCostInsightAlerts>[0];

    expect(formatActiveCostInsightAlerts(state, { type: 'user', id: 'personal-owner' })).toEqual([
      {
        type: 'anomaly',
        title: 'Spend is unusually high this hour',
        description: "Usage-based spend is well above this account's recent hourly pattern.",
        facts: [
          { label: 'This hour', value: '$112.70' },
          { label: 'Typical hour', value: '$6.00' },
          { label: 'Alert level', value: '$18.00' },
        ],
        driverEvidence: {
          title: 'Top Variable Credit spend drivers',
          description: 'Captured when the alert fired.',
          periodStart: '2026-06-25T19:00:00.000Z',
          periodEndExclusive: '2026-06-25T20:00:00.000Z',
          drivers: [
            {
              id: '["variable","ai_gateway","cli","messages","claude-sonnet-4","anthropic",null]',
              label: 'CLI: Messages',
              source: 'ai_gateway',
              actorLabel: undefined,
              modelOrProvider: 'claude-sonnet-4',
              category: 'Variable Credit spend',
              spendUsd: 74.2,
              requestCount: 184,
            },
          ],
          totalSpendUsd: 112.7,
          scope: 'current_hour',
        },
        actions: ['acknowledge', 'view_spend'],
      },
      {
        type: 'threshold',
        title: '24-hour spend threshold crossed',
        description: 'Spend reached $184.90 against the $150.00 threshold.',
        facts: [
          { label: 'Last 24 hours', value: '$184.90' },
          { label: 'Threshold', value: '$150.00' },
          { label: 'Amount over', value: '$34.90' },
        ],
        driverEvidence: {
          title: 'Top rolling 24-hour spend drivers',
          description: 'Captured when the threshold was crossed.',
          periodStart: '2026-06-24T19:02:00.000Z',
          periodEndExclusive: '2026-06-25T19:02:00.000Z',
          drivers: [
            {
              id: '["scheduled","kiloclaw","kiloclaw_hosting","renewal","standard","other",null]',
              label: 'Kiloclaw Hosting: Renewal',
              source: 'kiloclaw',
              actorLabel: undefined,
              modelOrProvider: 'standard',
              category: 'Scheduled Credit spend',
              spendUsd: 63.9,
              requestCount: 1,
            },
          ],
          totalSpendUsd: 184.9,
          scope: 'rolling_24h',
        },
        actions: ['acknowledge', 'view_spend', 'manage_threshold'],
      },
    ]);
  });

  it('formats an independent rolling 30-day threshold alert', () => {
    const state = {
      state: {
        activeAnomalyEventId: null,
        activeAnomalyHourStart: null,
        activeAnomalyReviewedAt: null,
        activeThresholdEventId: null,
        thresholdCrossingActive: false,
        thresholdReviewedAt: null,
        active7DayThresholdEventId: null,
        threshold7DayCrossingActive: false,
        threshold7DayReviewedAt: null,
        active30DayThresholdEventId: 'evt-threshold-30d',
        threshold30DayCrossingActive: true,
        threshold30DayReviewedAt: null,
        lastEvaluatedAt: '2026-06-25T19:02:00.000Z',
      },
      events: [
        {
          id: 'evt-threshold-30d',
          owned_by_user_id: 'personal-owner',
          owned_by_organization_id: null,
          event_type: 'threshold_crossed',
          alert_kind: 'threshold_30d',
          suggestion_kind: null,
          active_suggestion_id: null,
          actor_user_id: null,
          title: '30-day Spend Threshold Alert',
          description: 'Rolling 30-day Credit spend crossed $1,000.00.',
          snapshot: {
            thresholdWindow: 'rolling_30d',
            rolling30DayMicrodollars: 1_250_000_000,
            thresholdMicrodollars: 1_000_000_000,
            topDrivers: [],
          },
          dedupe_key: 'threshold_30d:1000000000:2026-06-25T19:02:00.000Z',
          occurred_at: '2026-06-25T19:02:00.000Z',
          created_at: '2026-06-25T19:02:00.000Z',
        },
      ],
    } as Parameters<typeof formatActiveCostInsightAlerts>[0];

    expect(formatActiveCostInsightAlerts(state, { type: 'user', id: 'personal-owner' })).toEqual([
      {
        type: 'threshold_30d',
        title: '30-day spend threshold crossed',
        description: 'Spend reached $1,250.00 against the $1,000.00 threshold.',
        facts: [
          { label: 'Last 30 days', value: '$1,250.00' },
          { label: 'Threshold', value: '$1,000.00' },
          { label: 'Amount over', value: '$250.00' },
        ],
        driverEvidence: undefined,
        actions: ['acknowledge', 'manage_threshold'],
      },
    ]);
  });

  it('formats an independent rolling 7-day threshold alert', () => {
    const state = {
      state: {
        activeAnomalyEventId: null,
        activeAnomalyHourStart: null,
        activeAnomalyReviewedAt: null,
        activeThresholdEventId: null,
        thresholdCrossingActive: false,
        thresholdReviewedAt: null,
        active7DayThresholdEventId: 'evt-threshold-7d',
        threshold7DayCrossingActive: true,
        threshold7DayReviewedAt: null,
        active30DayThresholdEventId: null,
        threshold30DayCrossingActive: false,
        threshold30DayReviewedAt: null,
        lastEvaluatedAt: '2026-06-25T19:02:00.000Z',
      },
      events: [
        {
          id: 'evt-threshold-7d',
          owned_by_user_id: 'personal-owner',
          owned_by_organization_id: null,
          event_type: 'threshold_crossed',
          alert_kind: 'threshold_7d',
          suggestion_kind: null,
          active_suggestion_id: null,
          actor_user_id: null,
          title: '7-day Spend Threshold Alert',
          description: 'Rolling 7-day Credit spend crossed $500.00.',
          snapshot: {
            thresholdWindow: 'rolling_7d',
            rolling7DayMicrodollars: 620_000_000,
            thresholdMicrodollars: 500_000_000,
            topDrivers: [],
          },
          dedupe_key: 'threshold_7d:500000000:2026-06-25T19:02:00.000Z',
          occurred_at: '2026-06-25T19:02:00.000Z',
          created_at: '2026-06-25T19:02:00.000Z',
        },
      ],
    } as Parameters<typeof formatActiveCostInsightAlerts>[0];

    expect(formatActiveCostInsightAlerts(state, { type: 'user', id: 'personal-owner' })).toEqual([
      {
        type: 'threshold_7d',
        title: '7-day spend threshold crossed',
        description: 'Spend reached $620.00 against the $500.00 threshold.',
        facts: [
          { label: 'Last 7 days', value: '$620.00' },
          { label: 'Threshold', value: '$500.00' },
          { label: 'Amount over', value: '$120.00' },
        ],
        driverEvidence: undefined,
        actions: ['acknowledge', 'manage_threshold'],
      },
    ]);
  });

  it('formats active Kilo Pass suggestions with spend window and plan facts', () => {
    const suggestions = [
      {
        id: 'suggestion-kilo-pass',
        suggestion_kind: 'kilo_pass',
        title: 'Get more credits with Kilo Pass Expert',
        description:
          'The plan includes $199 in paid credits plus up to $79.60 in free bonus credits.',
        evidence_window_start: '2026-06-18T19:00:00.000Z',
        evidence_window_end: '2026-06-25T19:00:00.000Z',
        observed_microdollars: 106_900_000,
        benefit_label: 'Expert plan',
        benefit_detail: '$199/month + up to $79.60 bonus',
        cta_label: 'View Kilo Pass Expert',
        cta_href: '/subscriptions/kilo-pass',
      },
    ] as CostInsightActiveSuggestion[];

    expect(formatActiveCostInsightSuggestions(suggestions)).toEqual([
      {
        id: 'suggestion-kilo-pass',
        type: 'kilo_pass',
        eyebrow: 'Cost Suggestion',
        title: 'Get more credits with Kilo Pass Expert',
        description:
          'The plan includes $199 in paid credits plus up to $79.60 in free bonus credits.',
        facts: [
          { label: 'Last 7 days', value: '$106.90' },
          { label: '30-day pace', value: '~$458' },
          { label: 'Expert plan', value: '$199/mo + up to $79.60 bonus' },
        ],
        ctaLabel: 'View Kilo Pass Expert',
        ctaHref: '/subscriptions/kilo-pass',
      },
    ]);
  });

  it('formats captured alert contributors using current member labels', () => {
    const events = [
      {
        id: 'event-threshold',
        eventType: 'threshold_crossed',
        alertKind: 'threshold',
        suggestionKind: null,
        actorUserId: null,
        actorName: null,
        title: 'Spend Threshold Alert',
        description: 'Rolling spend crossed the threshold.',
        snapshot: {
          rolling24HourMicrodollars: 25_000_000,
          topDrivers: [
            {
              spendCategory: 'variable',
              source: 'ai_gateway',
              productKey: 'kilo_code',
              featureKey: 'chat',
              modelOrPlanKey: 'claude-sonnet-4',
              providerKey: 'anthropic',
              actorUserId: 'member-1',
              totalMicrodollars: 12_500_000,
              spendRecordCount: 4,
            },
          ],
        },
        occurredAt: '2026-06-25T19:02:00.000Z',
      },
    ] as Parameters<typeof formatCostInsightEvents>[1];

    const [event] = formatCostInsightEvents(
      { type: 'organization', id: 'organization-1' },
      events,
      new Map([['member-1', 'Current Member']])
    );

    expect(event?.occurredAt).toBe('2026-06-25T19:02:00.000Z');
    expect(event?.topDrivers).toEqual([
      {
        id: '["variable","ai_gateway","kilo_code","chat","claude-sonnet-4","anthropic","member-1"]',
        label: 'Kilo Code: Chat',
        source: 'ai_gateway',
        actorLabel: 'Current Member',
        modelOrProvider: 'claude-sonnet-4',
        category: 'Variable Credit spend',
        spendUsd: 12.5,
        requestCount: 4,
      },
    ]);
  });
});
