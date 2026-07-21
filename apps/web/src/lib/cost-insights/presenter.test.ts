import type { CostInsightActiveSuggestion } from '@kilocode/db/schema';

import {
  formatActiveCostInsightAlerts,
  formatActiveCostInsightSuggestions,
  formatCostInsightEvents,
  formatSpendEvidence,
  normalizeCostInsightTimestamp,
  organizationMemberLimitsHref,
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
        activeAnomalyEpisodeId: 'evt-anomaly',
        activeAnomalyHourStart: '2026-06-25T19:00:00.000Z',
        activeAnomalySnapshot: null,
        activeAnomalyReviewedAt: null,
        activeThresholdEventId: 'evt-threshold',
        activeThresholdEpisodeId: 'evt-threshold',
        thresholdCrossingActive: true,
        activeThresholdSnapshot: null,
        thresholdReviewedAt: null,
        active7DayThresholdEventId: null,
        active7DayThresholdEpisodeId: null,
        threshold7DayCrossingActive: false,
        active7DayThresholdSnapshot: null,
        threshold7DayReviewedAt: null,
        active30DayThresholdEventId: null,
        active30DayThresholdEpisodeId: null,
        threshold30DayCrossingActive: false,
        active30DayThresholdSnapshot: null,
        threshold30DayReviewedAt: null,
        lastEvaluatedAt: '2026-06-25T19:02:00.000Z',
      },
      events: [
        {
          id: 'evt-anomaly',
          event_type: 'anomaly_alert',
          alert_kind: 'anomaly',
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
              startInclusive: '2026-06-25 21:00:00+02',
              endExclusive: '2026-06-25 22:00:00+02',
              spendCategory: 'variable',
            },
          },
        },
        {
          id: 'evt-threshold',
          event_type: 'threshold_crossed',
          alert_kind: 'threshold',
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
        eventId: 'evt-anomaly',
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
              label: 'CLI',
              source: 'ai_gateway',
              actorLabel: undefined,
              modelOrProvider: 'claude-sonnet-4',
              modelOrProviderLabel: 'Model',
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
        eventId: 'evt-threshold',
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
              label: 'KiloClaw subscription',
              source: 'kiloclaw',
              actorLabel: undefined,
              modelOrProvider: 'standard',
              modelOrProviderLabel: 'Plan',
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
        activeAnomalyEpisodeId: null,
        activeAnomalyHourStart: null,
        activeAnomalySnapshot: null,
        activeAnomalyReviewedAt: null,
        activeThresholdEventId: null,
        activeThresholdEpisodeId: null,
        thresholdCrossingActive: false,
        activeThresholdSnapshot: null,
        thresholdReviewedAt: null,
        active7DayThresholdEventId: null,
        active7DayThresholdEpisodeId: null,
        threshold7DayCrossingActive: false,
        active7DayThresholdSnapshot: null,
        threshold7DayReviewedAt: null,
        active30DayThresholdEventId: 'evt-threshold-30d',
        active30DayThresholdEpisodeId: 'evt-threshold-30d',
        threshold30DayCrossingActive: true,
        active30DayThresholdSnapshot: null,
        threshold30DayReviewedAt: null,
        lastEvaluatedAt: '2026-06-25T19:02:00.000Z',
      },
      events: [
        {
          id: 'evt-threshold-30d',
          event_type: 'threshold_crossed',
          alert_kind: 'threshold_30d',
          snapshot: {
            thresholdWindow: 'rolling_30d',
            rolling30DayMicrodollars: 1_250_000_000,
            thresholdMicrodollars: 1_000_000_000,
            topDrivers: [],
          },
        },
      ],
    } as Parameters<typeof formatActiveCostInsightAlerts>[0];

    expect(formatActiveCostInsightAlerts(state, { type: 'user', id: 'personal-owner' })).toEqual([
      {
        type: 'threshold_30d',
        eventId: 'evt-threshold-30d',
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
        activeAnomalyEpisodeId: null,
        activeAnomalyHourStart: null,
        activeAnomalySnapshot: null,
        activeAnomalyReviewedAt: null,
        activeThresholdEventId: null,
        activeThresholdEpisodeId: null,
        thresholdCrossingActive: false,
        activeThresholdSnapshot: null,
        thresholdReviewedAt: null,
        active7DayThresholdEventId: 'evt-threshold-7d',
        active7DayThresholdEpisodeId: 'evt-threshold-7d',
        threshold7DayCrossingActive: true,
        active7DayThresholdSnapshot: null,
        threshold7DayReviewedAt: null,
        active30DayThresholdEventId: null,
        active30DayThresholdEpisodeId: null,
        threshold30DayCrossingActive: false,
        active30DayThresholdSnapshot: null,
        threshold30DayReviewedAt: null,
        lastEvaluatedAt: '2026-06-25T19:02:00.000Z',
      },
      events: [
        {
          id: 'evt-threshold-7d',
          event_type: 'threshold_crossed',
          alert_kind: 'threshold_7d',
          snapshot: {
            thresholdWindow: 'rolling_7d',
            rolling7DayMicrodollars: 620_000_000,
            thresholdMicrodollars: 500_000_000,
            topDrivers: [],
          },
        },
      ],
    } as Parameters<typeof formatActiveCostInsightAlerts>[0];

    expect(formatActiveCostInsightAlerts(state, { type: 'user', id: 'personal-owner' })).toEqual([
      {
        type: 'threshold_7d',
        eventId: 'evt-threshold-7d',
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
    expect(event?.amountLabel).toBe('$25.00');
    expect(event?.topDrivers).toEqual([
      {
        id: '["variable","ai_gateway","kilo_code","chat","claude-sonnet-4","anthropic","member-1"]',
        label: 'Kilo Code: Chat',
        source: 'ai_gateway',
        actorLabel: 'Current Member',
        modelOrProvider: 'claude-sonnet-4',
        modelOrProviderLabel: 'Model',
        category: 'Variable Credit spend',
        spendUsd: 12.5,
        requestCount: 4,
      },
    ]);
  });

  it('omits implementation detail dimensions from contributor labels', () => {
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
              productKey: 'cloud_agent',
              featureKey: 'responses',
              modelOrPlanKey: 'openai/gpt-4.1',
              providerKey: 'openai',
              actorUserId: 'member-1',
              totalMicrodollars: 12_500_000,
              spendRecordCount: 4,
            },
            {
              spendCategory: 'scheduled',
              source: 'kiloclaw',
              productKey: 'kiloclaw_hosting',
              featureKey: 'renewal',
              modelOrPlanKey: 'standard',
              providerKey: 'other',
              actorUserId: 'member-1',
              totalMicrodollars: 10_000_000,
              spendRecordCount: 1,
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

    expect(event?.topDrivers?.map(driver => driver.label)).toEqual([
      'Cloud Agent',
      'KiloClaw subscription',
    ]);
    expect(event?.topDrivers?.at(1)?.modelOrProvider).toBe('standard');
    expect(event?.topDrivers?.at(1)?.modelOrProviderLabel).toBe('Plan');
  });

  it('preserves uncovered hourly evidence as unavailable instead of zero spend', () => {
    expect(
      formatSpendEvidence(
        [
          {
            hourStart: '2026-06-25 23:00:00+00',
            variableMicrodollars: null,
            scheduledMicrodollars: null,
            totalMicrodollars: null,
            variableRecordCount: null,
            scheduledRecordCount: null,
            isCovered: false,
          },
        ],
        '24h'
      )
    ).toEqual([
      {
        label: '23',
        periodStart: '2026-06-25T23:00:00.000Z',
        periodEndExclusive: '2026-06-26T00:00:00.000Z',
        coverage: 'unavailable',
        coveredHours: 0,
        totalHours: 1,
        variableUsd: null,
        scheduledUsd: null,
      },
    ]);
  });

  it('uses exact current-hour evidence when rollup coverage has not been initialized', () => {
    expect(
      formatSpendEvidence(
        [
          {
            hourStart: '2026-06-25T22:00:00.000Z',
            variableMicrodollars: null,
            scheduledMicrodollars: null,
            totalMicrodollars: null,
            variableRecordCount: null,
            scheduledRecordCount: null,
            isCovered: false,
          },
          {
            hourStart: '2026-06-25T23:00:00.000Z',
            variableMicrodollars: null,
            scheduledMicrodollars: null,
            totalMicrodollars: null,
            variableRecordCount: null,
            scheduledRecordCount: null,
            isCovered: false,
          },
        ],
        '24h',
        {
          hourStart: '2026-06-25T23:00:00.000Z',
          variableMicrodollars: 3_320_000,
          scheduledMicrodollars: 0,
          totalMicrodollars: 3_320_000,
          variableRecordCount: null,
          scheduledRecordCount: null,
          isCovered: true,
        }
      )
    ).toEqual([
      expect.objectContaining({
        periodStart: '2026-06-25T22:00:00.000Z',
        coverage: 'unavailable',
        variableUsd: null,
      }),
      expect.objectContaining({
        periodStart: '2026-06-25T23:00:00.000Z',
        coverage: 'complete',
        variableUsd: 3.32,
        scheduledUsd: 0,
      }),
    ]);
  });

  it('includes exact current-hour spend in a complete daily chart bucket', () => {
    const points = Array.from({ length: 24 }, (_, hour) => ({
      hourStart: `2026-06-25T${String(hour).padStart(2, '0')}:00:00.000Z`,
      variableMicrodollars: hour === 23 ? 3_320_000 : 0,
      scheduledMicrodollars: 0,
      totalMicrodollars: hour === 23 ? 3_320_000 : 0,
      variableRecordCount: hour === 23 ? 1 : 0,
      scheduledRecordCount: 0,
      isCovered: true,
    }));

    expect(formatSpendEvidence(points, '7d')).toEqual([
      expect.objectContaining({
        periodStart: '2026-06-25T00:00:00.000Z',
        periodEndExclusive: '2026-06-26T00:00:00.000Z',
        coverage: 'complete',
        variableUsd: 3.32,
        scheduledUsd: 0,
      }),
    ]);
  });

  it('rejects covered evidence with missing category totals instead of coercing it to zero', () => {
    expect(() =>
      formatSpendEvidence(
        [
          {
            hourStart: '2026-06-25T23:00:00.000Z',
            variableMicrodollars: null,
            scheduledMicrodollars: 1_000_000,
            totalMicrodollars: null,
            variableRecordCount: 0,
            scheduledRecordCount: 1,
            isCovered: true,
          },
        ],
        '24h'
      )
    ).toThrow('Covered Cost Insights evidence must include both spend categories.');
  });

  it('shows known spend in partial aggregate evidence without presenting it as a complete total', () => {
    const points = [
      {
        hourStart: '2026-06-25T22:00:00.000Z',
        variableMicrodollars: 2_000_000,
        scheduledMicrodollars: 1_000_000,
        totalMicrodollars: 3_000_000,
        variableRecordCount: 1,
        scheduledRecordCount: 1,
        isCovered: true,
      },
      {
        hourStart: '2026-06-25T23:00:00.000Z',
        variableMicrodollars: null,
        scheduledMicrodollars: null,
        totalMicrodollars: null,
        variableRecordCount: null,
        scheduledRecordCount: null,
        isCovered: false,
      },
      {
        hourStart: '2026-06-26T00:00:00.000Z',
        variableMicrodollars: null,
        scheduledMicrodollars: null,
        totalMicrodollars: null,
        variableRecordCount: null,
        scheduledRecordCount: null,
        isCovered: false,
      },
    ];

    expect(formatSpendEvidence(points, '30d')).toEqual([
      {
        label: 'Jun 25',
        periodStart: '2026-06-25T22:00:00.000Z',
        periodEndExclusive: '2026-06-26T00:00:00.000Z',
        coverage: 'partial',
        coveredHours: 1,
        totalHours: 2,
        variableUsd: 2,
        scheduledUsd: 1,
      },
      {
        label: 'Jun 26',
        periodStart: '2026-06-26T00:00:00.000Z',
        periodEndExclusive: '2026-06-26T01:00:00.000Z',
        coverage: 'unavailable',
        coveredHours: 0,
        totalHours: 1,
        variableUsd: null,
        scheduledUsd: null,
      },
    ]);
  });

  it('shows driver-backed spend from an uncovered hour as partial evidence', () => {
    expect(
      formatSpendEvidence(
        [
          {
            hourStart: '2026-06-25T23:00:00.000Z',
            variableMicrodollars: 4_000_000,
            scheduledMicrodollars: 1_000_000,
            totalMicrodollars: 5_000_000,
            variableRecordCount: 2,
            scheduledRecordCount: 1,
            isCovered: false,
          },
        ],
        '24h'
      )
    ).toEqual([
      {
        label: '23',
        periodStart: '2026-06-25T23:00:00.000Z',
        periodEndExclusive: '2026-06-26T00:00:00.000Z',
        coverage: 'partial',
        coveredHours: 0,
        totalHours: 1,
        variableUsd: 4,
        scheduledUsd: 1,
      },
    ]);
  });

  it('retains period boundaries and sums only fully covered 90-day buckets', () => {
    const points = Array.from({ length: 2 }, (_, index) => ({
      hourStart: `2026-06-25T${String(22 + index).padStart(2, '0')}:00:00.000Z`,
      variableMicrodollars: 2_000_000,
      scheduledMicrodollars: 1_000_000,
      totalMicrodollars: 3_000_000,
      variableRecordCount: 1,
      scheduledRecordCount: 1,
      isCovered: true,
    }));

    expect(formatSpendEvidence(points, '90d')).toEqual([
      {
        label: 'Jun 25',
        periodStart: '2026-06-25T22:00:00.000Z',
        periodEndExclusive: '2026-06-26T00:00:00.000Z',
        coverage: 'complete',
        coveredHours: 2,
        totalHours: 2,
        variableUsd: 4,
        scheduledUsd: 2,
      },
    ]);
  });

  it('aggregates 7-day evidence into daily buckets instead of hourly bars', () => {
    const points = Array.from({ length: 26 }, (_, index) => ({
      hourStart: new Date(Date.UTC(2026, 5, 25, index)).toISOString(),
      variableMicrodollars: 1_000_000,
      scheduledMicrodollars: 0,
      totalMicrodollars: 1_000_000,
      variableRecordCount: 1,
      scheduledRecordCount: 0,
      isCovered: true,
    }));

    const buckets = formatSpendEvidence(points, '7d');

    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({
      label: 'Jun 25',
      periodStart: '2026-06-25T00:00:00.000Z',
      coverage: 'complete',
      coveredHours: 24,
      totalHours: 24,
      variableUsd: 24,
      scheduledUsd: 0,
    });
    expect(buckets[1]).toMatchObject({
      label: 'Jun 26',
      periodStart: '2026-06-26T00:00:00.000Z',
      coverage: 'complete',
      coveredHours: 2,
      totalHours: 2,
      variableUsd: 2,
    });
  });

  it('normalizes production-shaped Postgres timestamps at the presentation boundary', () => {
    expect(normalizeCostInsightTimestamp('2026-06-25 21:02:00+02')).toBe(
      '2026-06-25T19:02:00.000Z'
    );

    const [event] = formatCostInsightEvents({ type: 'user', id: 'personal-owner' }, [
      {
        id: 'event-1',
        eventType: 'config_changed',
        alertKind: null,
        suggestionKind: null,
        actorUserId: null,
        actorName: null,
        title: 'Settings changed',
        description: 'Settings changed.',
        snapshot: {},
        occurredAt: '2026-06-25 21:02:00+02',
      },
    ]);
    expect(event?.occurredAt).toBe('2026-06-25T19:02:00.000Z');
  });

  it('links member limits only when presenter inputs prove eligibility and availability', () => {
    const base = {
      owner: { type: 'organization', id: 'organization-1' } as const,
      plan: 'enterprise' as const,
      usageLimitsEnabled: true,
    };
    expect(
      organizationMemberLimitsHref({
        ...base,
        uiOwner: { type: 'organization', name: 'Org', authorizedRole: 'owner' },
      })
    ).toBe('/organizations/organization-1');
    expect(
      organizationMemberLimitsHref({
        ...base,
        uiOwner: { type: 'organization', name: 'Org', authorizedRole: 'admin' },
      })
    ).toBeUndefined();
    expect(
      organizationMemberLimitsHref({
        ...base,
        uiOwner: { type: 'organization', name: 'Org', authorizedRole: 'billing_manager' },
      })
    ).toBeUndefined();
    expect(
      organizationMemberLimitsHref({
        ...base,
        plan: 'teams',
        uiOwner: { type: 'organization', name: 'Org', authorizedRole: 'owner' },
      })
    ).toBeUndefined();
    expect(
      organizationMemberLimitsHref({
        ...base,
        usageLimitsEnabled: false,
        uiOwner: { type: 'organization', name: 'Org', authorizedRole: 'admin' },
      })
    ).toBeUndefined();
  });
});
