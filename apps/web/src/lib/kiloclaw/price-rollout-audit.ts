import {
  CURRENT_KILOCLAW_PRICE_VERSION,
  LEGACY_KILOCLAW_PRICE_VERSION,
  getKiloClawPricingCatalogEntry,
} from '@kilocode/db';

const LIVE_STATUSES = new Set(['active', 'past-due', 'past_due', 'unpaid', 'trialing']);

export type KiloClawRolloutAuditStripePriceIds = {
  legacy: {
    standardIntro: string;
    standard: string;
    commit: string;
  };
  current: {
    standard: string;
    commit: string;
  };
};

export type KiloClawRolloutAuditSubscription = {
  id: string;
  userId: string;
  createdAtIso: string;
  status: string;
  priceVersion: string;
  stripeSubscriptionId: string | null;
  transferredToSubscriptionId: string | null;
  instanceId: string | null;
};

export type KiloClawRolloutAuditInstance = {
  id: string;
  userId: string;
  organizationId: string | null;
  createdAtIso: string;
  destroyedAtIso: string | null;
  instanceType: string | null;
  hasAdminSizeOverride: boolean;
};

export type KiloClawRolloutAuditStripeSubscriptionPrices = {
  subscriptionId: string;
  priceIds: string[];
};

export type KiloClawRolloutAuditHardcodedPriceHit = {
  path: string;
  line: number;
  value: string;
  text: string;
};

export type KiloClawRolloutAuditInput = {
  nowIso: string;
  rolloutStartedAtIso: string;
  legacyEntitlementCorrectionDeployedAtIso: string;
  stripePriceIds: KiloClawRolloutAuditStripePriceIds;
  subscriptions: KiloClawRolloutAuditSubscription[];
  instances: KiloClawRolloutAuditInstance[];
  stripeSubscriptionPrices: KiloClawRolloutAuditStripeSubscriptionPrices[];
  hardcodedPriceHits: KiloClawRolloutAuditHardcodedPriceHit[];
};

type KiloClawRolloutAuditCheckId =
  | 'pre_rollout_rows_are_legacy'
  | 'current_rows_do_not_use_legacy_stripe_prices'
  | 'legacy_rows_do_not_use_current_stripe_prices'
  | 'canceled_rows_do_not_seed_live_lineage'
  | 'entitlement_matches_price_version'
  | 'hardcoded_legacy_amounts_only_in_catalog_or_tests';

export type KiloClawRolloutAuditFailure = {
  subject: string;
  detail: string;
  action: string;
};

export type KiloClawRolloutAuditCheck = {
  id: KiloClawRolloutAuditCheckId;
  title: string;
  failures: KiloClawRolloutAuditFailure[];
};

export type KiloClawRolloutAuditResult = {
  ok: boolean;
  generatedAtIso: string;
  failedCheckIds: KiloClawRolloutAuditCheckId[];
  checks: KiloClawRolloutAuditCheck[];
};

function isLiveStatus(status: string): boolean {
  return LIVE_STATUSES.has(status);
}

function getPersonalInstance(
  row: KiloClawRolloutAuditSubscription,
  instancesById: Map<string, KiloClawRolloutAuditInstance>
): KiloClawRolloutAuditInstance | null {
  if (!row.instanceId) return null;
  const instance = instancesById.get(row.instanceId);
  if (!instance || instance.userId !== row.userId || instance.organizationId !== null) return null;
  return instance;
}

function isCurrentPersonalLineageSource(
  row: KiloClawRolloutAuditSubscription,
  instancesById: Map<string, KiloClawRolloutAuditInstance>
): boolean {
  if (row.transferredToSubscriptionId) return false;
  const instance = getPersonalInstance(row, instancesById);
  return instance?.destroyedAtIso === null;
}

function priceSet(values: string[]): Set<string> {
  return new Set(values.filter(Boolean));
}

function findStripeFixture(
  input: KiloClawRolloutAuditInput,
  subscriptionId: string
): KiloClawRolloutAuditStripeSubscriptionPrices | null {
  return input.stripeSubscriptionPrices.find(row => row.subscriptionId === subscriptionId) ?? null;
}

function hasAnyPrice(priceIds: string[], candidates: Set<string>): boolean {
  return priceIds.some(priceId => candidates.has(priceId));
}

function formatPriceIds(priceIds: string[]): string {
  return priceIds.length > 0 ? priceIds.join(', ') : '(none)';
}

function isAllowedHardcodedPricePath(path: string): boolean {
  return (
    path === 'packages/db/src/kiloclaw-pricing-catalog.ts' ||
    path.endsWith('.test.ts') ||
    path.endsWith('.test.tsx') ||
    path.includes('/__tests__/') ||
    path.includes('/test/') ||
    path.includes('/tests/')
  );
}

export function evaluateKiloClawPriceRolloutAudit(
  input: KiloClawRolloutAuditInput
): KiloClawRolloutAuditResult {
  const rolloutStartedAt = Date.parse(input.rolloutStartedAtIso);
  const legacyEntitlementCorrectionDeployedAt = Date.parse(
    input.legacyEntitlementCorrectionDeployedAtIso
  );
  const legacyStripePrices = priceSet([
    input.stripePriceIds.legacy.standardIntro,
    input.stripePriceIds.legacy.standard,
    input.stripePriceIds.legacy.commit,
  ]);
  const currentStripePrices = priceSet([
    input.stripePriceIds.current.standard,
    input.stripePriceIds.current.commit,
  ]);
  const instancesById = new Map(input.instances.map(instance => [instance.id, instance]));
  const transferredPredecessorsBySuccessorId = new Map<
    string,
    KiloClawRolloutAuditSubscription[]
  >();
  for (const row of input.subscriptions) {
    if (!row.transferredToSubscriptionId) continue;
    const predecessors = transferredPredecessorsBySuccessorId.get(row.transferredToSubscriptionId);
    if (predecessors) {
      predecessors.push(row);
    } else {
      transferredPredecessorsBySuccessorId.set(row.transferredToSubscriptionId, [row]);
    }
  }
  const canceledLegacyHistorySourceIdsByUserId = new Map<string, string[]>();
  for (const row of input.subscriptions) {
    if (
      row.status !== 'canceled' ||
      row.priceVersion !== LEGACY_KILOCLAW_PRICE_VERSION ||
      row.transferredToSubscriptionId ||
      isCurrentPersonalLineageSource(row, instancesById) ||
      !getPersonalInstance(row, instancesById)
    ) {
      continue;
    }
    const sourceIds = canceledLegacyHistorySourceIdsByUserId.get(row.userId);
    if (sourceIds) {
      sourceIds.push(row.id);
    } else {
      canceledLegacyHistorySourceIdsByUserId.set(row.userId, [row.id]);
    }
  }

  const checks: KiloClawRolloutAuditCheck[] = [
    {
      id: 'pre_rollout_rows_are_legacy',
      title: 'All rows created before current-price rollout use the legacy price version',
      failures: input.subscriptions
        .filter(row => Date.parse(row.createdAtIso) < rolloutStartedAt)
        .filter(row => row.priceVersion !== LEGACY_KILOCLAW_PRICE_VERSION)
        .map(row => ({
          subject: row.id,
          detail: `createdAt=${row.createdAtIso} priceVersion=${row.priceVersion}`,
          action: `Backfill historical row ${row.id} to ${LEGACY_KILOCLAW_PRICE_VERSION} or document why it was created after rollout with a corrected timestamp.`,
        })),
    },
    {
      id: 'current_rows_do_not_use_legacy_stripe_prices',
      title: 'Active/current-price rows do not use legacy Stripe price IDs',
      failures: input.subscriptions
        .filter(row => isLiveStatus(row.status))
        .filter(row => row.priceVersion === CURRENT_KILOCLAW_PRICE_VERSION)
        .filter(row => row.stripeSubscriptionId)
        .flatMap(row => {
          const subscriptionId = row.stripeSubscriptionId;
          if (!subscriptionId) return [];
          const fixture = findStripeFixture(input, subscriptionId);
          if (!fixture || !hasAnyPrice(fixture.priceIds, legacyStripePrices)) return [];
          return [
            {
              subject: row.id,
              detail: `stripeSubscriptionId=${subscriptionId} priceIds=${formatPriceIds(fixture.priceIds)}`,
              action: `Move Stripe subscription ${subscriptionId} to a current KiloClaw price or correct row ${row.id}'s price version before rollout.`,
            },
          ];
        }),
    },
    {
      id: 'legacy_rows_do_not_use_current_stripe_prices',
      title: 'Active/legacy-price rows do not use current Stripe price IDs',
      failures: input.subscriptions
        .filter(row => isLiveStatus(row.status))
        .filter(row => row.priceVersion === LEGACY_KILOCLAW_PRICE_VERSION)
        .filter(row => row.stripeSubscriptionId)
        .flatMap(row => {
          const subscriptionId = row.stripeSubscriptionId;
          if (!subscriptionId) return [];
          const fixture = findStripeFixture(input, subscriptionId);
          if (!fixture || !hasAnyPrice(fixture.priceIds, currentStripePrices)) return [];
          return [
            {
              subject: row.id,
              detail: `stripeSubscriptionId=${subscriptionId} priceIds=${formatPriceIds(fixture.priceIds)}`,
              action: `Move Stripe subscription ${subscriptionId} back to legacy prices or correct row ${row.id}'s price version; do not silently migrate the lineage.`,
            },
          ];
        }),
    },
    {
      id: 'canceled_rows_do_not_seed_live_lineage',
      title: 'Canceled rows are not selected as live lineage sources',
      failures: [
        ...input.subscriptions
          .filter(row => row.status === 'canceled')
          .filter(row => isCurrentPersonalLineageSource(row, instancesById))
          .map(row => ({
            subject: row.id,
            detail: `status=${row.status} instanceId=${row.instanceId} transferredToSubscriptionId=(null) priceVersion=${row.priceVersion}`,
            action: `Mark row ${row.id} as transferred to its live successor or correct the current personal lineage selector before rollout; a canceled current row must not seed fresh legacy eligibility.`,
          })),
        ...input.subscriptions
          .filter(row => row.priceVersion === LEGACY_KILOCLAW_PRICE_VERSION)
          .filter(row => Date.parse(row.createdAtIso) >= rolloutStartedAt)
          .filter(row => isLiveStatus(row.status))
          .filter(row => isCurrentPersonalLineageSource(row, instancesById))
          .filter(row => !transferredPredecessorsBySuccessorId.has(row.id))
          .flatMap(row => {
            const sourceIds = canceledLegacyHistorySourceIdsByUserId.get(row.userId) ?? [];
            if (sourceIds.length === 0) return [];
            return [
              {
                subject: row.id,
                detail: `successorId=${row.id} canceledHistorySourceIds=${sourceIds.join(', ')} priceVersion=${row.priceVersion} createdAt=${row.createdAtIso}`,
                action: `Repair a valid live transfer pointer into successor ${row.id} or update successor ${row.id} to ${CURRENT_KILOCLAW_PRICE_VERSION}; canceled history cannot seed legacy eligibility.`,
              },
            ];
          }),
      ],
    },
    {
      id: 'entitlement_matches_price_version',
      title: 'Active instance entitlement matches the live subscription price version',
      failures: input.subscriptions
        .filter(row => isLiveStatus(row.status))
        .filter(row => !row.transferredToSubscriptionId)
        .filter(row => row.instanceId)
        .flatMap(row => {
          const instanceId = row.instanceId;
          if (!instanceId) return [];
          const instance = instancesById.get(instanceId);
          if (!instance || instance.destroyedAtIso || instance.hasAdminSizeOverride) return [];
          const expected = getKiloClawPricingCatalogEntry(row.priceVersion).selfServiceInstanceType;
          if (instance.instanceType === expected) return [];
          const isToleratedLegacyLag =
            row.priceVersion === LEGACY_KILOCLAW_PRICE_VERSION &&
            instance.instanceType === 'shared-2-3' &&
            Date.parse(instance.createdAtIso) < legacyEntitlementCorrectionDeployedAt;
          if (isToleratedLegacyLag) return [];
          return [
            {
              subject: instance.id,
              detail: `subscriptionId=${row.id} priceVersion=${row.priceVersion} expectedInstanceType=${expected} actualInstanceType=${instance.instanceType ?? '(null)'}`,
              action: `Correct instance ${instance.id} entitlement metadata or investigate provisioning drift for subscription ${row.id}.`,
            },
          ];
        }),
    },
    {
      id: 'hardcoded_legacy_amounts_only_in_catalog_or_tests',
      title: 'Hard-coded legacy amounts appear only in catalog or tests',
      failures: input.hardcodedPriceHits
        .filter(hit => !isAllowedHardcodedPricePath(hit.path))
        .map(hit => ({
          subject: `${hit.path}:${hit.line}`,
          detail: `value=${hit.value} text=${hit.text.trim()}`,
          action: `Replace ${hit.path}:${hit.line} with a KiloClaw pricing catalog lookup.`,
        })),
    },
  ];

  const failedCheckIds = checks.filter(check => check.failures.length > 0).map(check => check.id);

  return {
    ok: failedCheckIds.length === 0,
    generatedAtIso: input.nowIso,
    failedCheckIds,
    checks,
  };
}

export function formatKiloClawPriceRolloutAuditReport(result: KiloClawRolloutAuditResult): string {
  const lines = [
    `KiloClaw price rollout audit generated at ${result.generatedAtIso}`,
    `Result: ${result.ok ? 'PASS' : 'FAIL'}`,
  ];

  for (const check of result.checks) {
    const status = check.failures.length === 0 ? 'PASS' : 'FAIL';
    lines.push('', `${status} ${check.id}`, check.title);
    if (check.failures.length === 0) {
      lines.push('  No findings.');
      continue;
    }
    for (const failure of check.failures) {
      lines.push(`  - ${failure.subject}`);
      lines.push(`    Detail: ${failure.detail}`);
      lines.push(`    Action: ${failure.action}`);
    }
  }

  return lines.join('\n');
}
