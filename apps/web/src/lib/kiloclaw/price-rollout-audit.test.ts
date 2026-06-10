import {
  evaluateKiloClawPriceRolloutAudit,
  formatKiloClawPriceRolloutAuditReport,
  type KiloClawRolloutAuditInput,
} from './price-rollout-audit';

const auditInput: KiloClawRolloutAuditInput = {
  nowIso: '2026-05-12T00:00:00.000Z',
  rolloutStartedAtIso: '2026-05-10T00:00:00.000Z',
  legacyEntitlementCorrectionDeployedAtIso: '2026-05-12T12:00:00.000Z',
  stripePriceIds: {
    legacy: {
      standardIntro: 'price_legacy_intro',
      standard: 'price_legacy_standard',
      commit: 'price_legacy_commit',
    },
    current: {
      standard: 'price_current_standard',
      commit: 'price_current_commit',
    },
  },
  stripeSubscriptionPrices: [
    { subscriptionId: 'sub_current_on_legacy', priceIds: ['price_legacy_standard'] },
    { subscriptionId: 'sub_legacy_on_current', priceIds: ['price_current_commit'] },
  ],
  subscriptions: [
    {
      id: 'pre-rollout-current-version',
      userId: 'user_1',
      createdAtIso: '2026-05-09T23:59:59.000Z',
      status: 'canceled',
      priceVersion: '2026-05-10',
      stripeSubscriptionId: null,
      transferredToSubscriptionId: null,
      instanceId: 'instance_pre_rollout',
    },
    {
      id: 'current-row-legacy-price',
      userId: 'user_2',
      createdAtIso: '2026-05-11T00:00:00.000Z',
      status: 'active',
      priceVersion: '2026-05-10',
      stripeSubscriptionId: 'sub_current_on_legacy',
      transferredToSubscriptionId: null,
      instanceId: 'instance_current_wrong_tier',
    },
    {
      id: 'legacy-row-current-price',
      userId: 'user_3',
      createdAtIso: '2026-05-01T00:00:00.000Z',
      status: 'active',
      priceVersion: '2026-03-19',
      stripeSubscriptionId: 'sub_legacy_on_current',
      transferredToSubscriptionId: null,
      instanceId: 'instance_legacy_ok_tier',
    },
  ],
  instances: [
    {
      id: 'instance_current_wrong_tier',
      userId: 'user_2',
      organizationId: null,
      createdAtIso: '2026-05-11T00:00:00.000Z',
      destroyedAtIso: null,
      instanceType: 'shared-2-3',
      hasAdminSizeOverride: false,
    },
    {
      id: 'instance_legacy_ok_tier',
      userId: 'user_3',
      organizationId: null,
      createdAtIso: '2026-05-01T00:00:00.000Z',
      destroyedAtIso: null,
      instanceType: 'perf-1-3',
      hasAdminSizeOverride: false,
    },
  ],
  hardcodedPriceHits: [
    {
      path: 'apps/web/src/lib/kiloclaw/credit-billing.ts',
      line: 42,
      value: '9_000_000',
      text: 'const standard = 9_000_000;',
    },
  ],
};

const passingAuditInput: KiloClawRolloutAuditInput = {
  ...auditInput,
  stripeSubscriptionPrices: [],
  subscriptions: [],
  instances: [],
  hardcodedPriceHits: [],
};

describe('KiloClaw price rollout audit', () => {
  it('tolerates active legacy shared-2-3 instances created before the entitlement correction deployment cutoff', () => {
    const result = evaluateKiloClawPriceRolloutAudit({
      ...passingAuditInput,
      legacyEntitlementCorrectionDeployedAtIso: '2026-05-12T12:00:00.000Z',
      subscriptions: [
        {
          id: 'pre-cutoff-legacy-shared',
          userId: 'user_legacy_lag',
          createdAtIso: '2026-05-01T00:00:00.000Z',
          status: 'active',
          priceVersion: '2026-03-19',
          stripeSubscriptionId: null,
          transferredToSubscriptionId: null,
          instanceId: 'pre-cutoff-shared-instance',
        },
      ],
      instances: [
        {
          id: 'pre-cutoff-shared-instance',
          userId: 'user_legacy_lag',
          organizationId: null,
          createdAtIso: '2026-05-12T11:59:59.000Z',
          destroyedAtIso: null,
          instanceType: 'shared-2-3',
          hasAdminSizeOverride: false,
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.failedCheckIds).not.toContain('entitlement_matches_price_version');
  });

  it('flags active legacy shared-2-3 instances created at or after the entitlement correction deployment cutoff', () => {
    const result = evaluateKiloClawPriceRolloutAudit({
      ...passingAuditInput,
      legacyEntitlementCorrectionDeployedAtIso: '2026-05-12T12:00:00.000Z',
      subscriptions: [
        {
          id: 'post-cutoff-legacy-shared',
          userId: 'user_legacy_drift',
          createdAtIso: '2026-05-01T00:00:00.000Z',
          status: 'active',
          priceVersion: '2026-03-19',
          stripeSubscriptionId: null,
          transferredToSubscriptionId: null,
          instanceId: 'post-cutoff-shared-instance',
        },
      ],
      instances: [
        {
          id: 'post-cutoff-shared-instance',
          userId: 'user_legacy_drift',
          organizationId: null,
          createdAtIso: '2026-05-12T12:00:00.000Z',
          destroyedAtIso: null,
          instanceType: 'shared-2-3',
          hasAdminSizeOverride: false,
        },
      ],
    });

    expect(result.failedCheckIds).toContain('entitlement_matches_price_version');
    const entitlementCheck = result.checks.find(
      check => check.id === 'entitlement_matches_price_version'
    );
    expect(entitlementCheck?.failures).toEqual([
      expect.objectContaining({
        subject: 'post-cutoff-shared-instance',
        detail: expect.stringContaining('actualInstanceType=shared-2-3'),
      }),
    ]);
  });

  it('flags current-price shared-2-3 instances even when they were created before the entitlement correction deployment cutoff', () => {
    const result = evaluateKiloClawPriceRolloutAudit({
      ...passingAuditInput,
      legacyEntitlementCorrectionDeployedAtIso: '2026-05-12T12:00:00.000Z',
      subscriptions: [
        {
          id: 'current-shared-drift',
          userId: 'user_current_drift',
          createdAtIso: '2026-05-12T00:00:00.000Z',
          status: 'active',
          priceVersion: '2026-05-10',
          stripeSubscriptionId: null,
          transferredToSubscriptionId: null,
          instanceId: 'current-shared-instance',
        },
      ],
      instances: [
        {
          id: 'current-shared-instance',
          userId: 'user_current_drift',
          organizationId: null,
          createdAtIso: '2026-05-12T11:59:59.000Z',
          destroyedAtIso: null,
          instanceType: 'shared-2-3',
          hasAdminSizeOverride: false,
        },
      ],
    });

    expect(result.failedCheckIds).toContain('entitlement_matches_price_version');
    const entitlementCheck = result.checks.find(
      check => check.id === 'entitlement_matches_price_version'
    );
    expect(entitlementCheck?.failures).toEqual([
      expect.objectContaining({
        subject: 'current-shared-instance',
        detail: expect.stringContaining('priceVersion=2026-05-10'),
      }),
    ]);
  });

  it('reports actionable failures for rollout-blocking price-version, Stripe family, entitlement, and hard-coded amount mismatches', () => {
    const result = evaluateKiloClawPriceRolloutAudit(auditInput);

    expect(result.ok).toBe(false);
    expect(result.failedCheckIds).toEqual([
      'pre_rollout_rows_are_legacy',
      'current_rows_do_not_use_legacy_stripe_prices',
      'legacy_rows_do_not_use_current_stripe_prices',
      'entitlement_matches_price_version',
      'hardcoded_legacy_amounts_only_in_catalog_or_tests',
    ]);

    const report = formatKiloClawPriceRolloutAuditReport(result);
    expect(report).toContain('FAIL pre_rollout_rows_are_legacy');
    expect(report).toContain('pre-rollout-current-version');
    expect(report).toContain('sub_current_on_legacy');
    expect(report).toContain('instance_current_wrong_tier');
    expect(report).toContain('apps/web/src/lib/kiloclaw/credit-billing.ts:42');
    expect(report).toContain('Action:');
  });

  it('flags canceled rows that runtime can still select as current personal lineage sources', () => {
    const result = evaluateKiloClawPriceRolloutAudit({
      ...passingAuditInput,
      subscriptions: [
        {
          id: 'canceled-current-source',
          userId: 'user_current_source',
          createdAtIso: '2026-05-01T00:00:00.000Z',
          status: 'canceled',
          priceVersion: '2026-03-19',
          stripeSubscriptionId: null,
          transferredToSubscriptionId: null,
          instanceId: 'live-personal-instance',
        },
      ],
      instances: [
        {
          id: 'live-personal-instance',
          userId: 'user_current_source',
          organizationId: null,
          createdAtIso: '2026-05-01T00:00:00.000Z',
          destroyedAtIso: null,
          instanceType: 'shared-2-3',
          hasAdminSizeOverride: false,
        },
      ],
    });

    expect(result.failedCheckIds).toContain('canceled_rows_do_not_seed_live_lineage');
    const lineageCheck = result.checks.find(
      check => check.id === 'canceled_rows_do_not_seed_live_lineage'
    );
    expect(lineageCheck?.failures).toEqual([
      expect.objectContaining({
        subject: 'canceled-current-source',
        detail: expect.stringContaining('instanceId=live-personal-instance'),
        action: expect.stringContaining('Mark row canceled-current-source as transferred'),
      }),
    ]);
  });

  it('flags post-rollout legacy successors that only have canceled history as their lineage source', () => {
    const result = evaluateKiloClawPriceRolloutAudit({
      ...passingAuditInput,
      subscriptions: [
        {
          id: 'canceled-history-source',
          userId: 'user_legacy_leak',
          createdAtIso: '2026-05-01T00:00:00.000Z',
          status: 'canceled',
          priceVersion: '2026-03-19',
          stripeSubscriptionId: null,
          transferredToSubscriptionId: null,
          instanceId: 'destroyed-history-instance',
        },
        {
          id: 'fresh-legacy-successor',
          userId: 'user_legacy_leak',
          createdAtIso: '2026-05-11T00:00:00.000Z',
          status: 'active',
          priceVersion: '2026-03-19',
          stripeSubscriptionId: null,
          transferredToSubscriptionId: null,
          instanceId: 'fresh-instance',
        },
      ],
      instances: [
        {
          id: 'destroyed-history-instance',
          userId: 'user_legacy_leak',
          organizationId: null,
          createdAtIso: '2026-05-01T00:00:00.000Z',
          destroyedAtIso: '2026-05-09T00:00:00.000Z',
          instanceType: 'shared-2-3',
          hasAdminSizeOverride: false,
        },
        {
          id: 'fresh-instance',
          userId: 'user_legacy_leak',
          organizationId: null,
          createdAtIso: '2026-05-11T00:00:00.000Z',
          destroyedAtIso: null,
          instanceType: 'perf-1-3',
          hasAdminSizeOverride: false,
        },
      ],
    });

    expect(result.failedCheckIds).toContain('canceled_rows_do_not_seed_live_lineage');
    const report = formatKiloClawPriceRolloutAuditReport(result);
    expect(report).toContain('fresh-legacy-successor');
    expect(report).toContain('canceledHistorySourceIds=canceled-history-source');
    expect(report).toContain('Repair a valid live transfer pointer');
  });

  it('allows valid transferred predecessors to point at a successor without failing lineage audit', () => {
    const result = evaluateKiloClawPriceRolloutAudit({
      ...passingAuditInput,
      subscriptions: [
        {
          id: 'legacy-predecessor',
          userId: 'user_transfer',
          createdAtIso: '2026-05-01T00:00:00.000Z',
          status: 'canceled',
          priceVersion: '2026-03-19',
          stripeSubscriptionId: null,
          transferredToSubscriptionId: 'legacy-successor',
          instanceId: 'old-instance',
        },
        {
          id: 'legacy-successor',
          userId: 'user_transfer',
          createdAtIso: '2026-05-11T00:00:00.000Z',
          status: 'active',
          priceVersion: '2026-03-19',
          stripeSubscriptionId: null,
          transferredToSubscriptionId: null,
          instanceId: 'new-instance',
        },
      ],
      instances: [
        {
          id: 'old-instance',
          userId: 'user_transfer',
          organizationId: null,
          createdAtIso: '2026-05-01T00:00:00.000Z',
          destroyedAtIso: '2026-05-10T12:00:00.000Z',
          instanceType: 'shared-2-3',
          hasAdminSizeOverride: false,
        },
        {
          id: 'new-instance',
          userId: 'user_transfer',
          organizationId: null,
          createdAtIso: '2026-05-11T00:00:00.000Z',
          destroyedAtIso: null,
          instanceType: 'perf-1-3',
          hasAdminSizeOverride: false,
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.failedCheckIds).not.toContain('canceled_rows_do_not_seed_live_lineage');
  });
});
