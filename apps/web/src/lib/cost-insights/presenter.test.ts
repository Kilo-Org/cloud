import type { CostInsightActiveSuggestion } from '@kilocode/db/schema';

import {
  formatActiveCostInsightAlerts,
  formatActiveCostInsightSuggestions,
  formatCostInsightEvents,
} from './presenter';

describe('Cost Insights presenter', () => {
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
          },
        },
        {
          event_type: 'threshold_crossed',
          snapshot: {
            rolling24HourMicrodollars: 184_900_000,
            thresholdMicrodollars: 150_000_000,
          },
        },
      ],
    } as Parameters<typeof formatActiveCostInsightAlerts>[0];

    expect(formatActiveCostInsightAlerts(state)).toEqual([
      {
        type: 'anomaly',
        title: 'Spend is unusually high this hour',
        description: "Usage-based spend is well above this account's recent hourly pattern.",
        facts: [
          { label: 'This hour', value: '$112.70' },
          { label: 'Typical hour', value: '$6.00' },
          { label: 'Alert level', value: '$18.00' },
        ],
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
        actions: ['acknowledge', 'adjust_threshold', 'disable_threshold'],
      },
    ]);
  });

  it('formats active Kilo Pass suggestions with spend window and plan facts', () => {
    const suggestions = [
      {
        id: 'suggestion-kilo-pass',
        suggestion_kind: 'kilo_pass',
        title: 'Get more credits from your monthly spend with Kilo Pass Expert',
        description:
          'You spent $106.90 on pay-as-you-go credits in the last 7 days, about $458 over 30 days at the same pace. Kilo Pass Expert costs $199 per month and includes $199 in paid credits, plus up to $79.60 in free bonus credits. Based on your recent spend, the plan could give you more credits for part of the spend you already make.',
        evidence_window_start: '2026-06-18T19:00:00.000Z',
        evidence_window_end: '2026-06-25T19:00:00.000Z',
        observed_microdollars: 106_900_000,
        benefit_label: 'Expert plan',
        benefit_detail: '$199 + up to $79.60 bonus',
        cta_label: 'View Kilo Pass Expert',
        cta_href: '/subscriptions/kilo-pass',
      },
    ] as CostInsightActiveSuggestion[];

    expect(formatActiveCostInsightSuggestions(suggestions)).toEqual([
      {
        id: 'suggestion-kilo-pass',
        type: 'kilo_pass',
        eyebrow: 'Cost Suggestion',
        title: 'Get more credits from your monthly spend with Kilo Pass Expert',
        description:
          'You spent $106.90 on pay-as-you-go credits in the last 7 days, about $458 over 30 days at the same pace. Kilo Pass Expert costs $199 per month and includes $199 in paid credits, plus up to $79.60 in free bonus credits. Based on your recent spend, the plan could give you more credits for part of the spend you already make.',
        facts: [
          { label: 'Last 7 days', value: '$106.90' },
          { label: '30-day pace', value: '~$458' },
          { label: 'Expert plan', value: '$199 + up to $79.60 bonus' },
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
