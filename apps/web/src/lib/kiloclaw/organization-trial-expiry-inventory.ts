import {
  classifyOrganizationEntitlement,
  type OrganizationEntitlementBypassReason,
} from '@kilocode/organization-entitlement';
import type { OrganizationTrialExpiryCandidateRow } from '@kilocode/db/kiloclaw-organization-trial-expiry-candidates';

export type OrganizationTrialExpiryInventoryEntitlementReason = Exclude<
  OrganizationEntitlementBypassReason,
  null
>;

export type OrganizationTrialExpiryInventoryItem = {
  subscriptionId: string;
  organizationId: string | null;
  instanceId: string | null;
  hardExpiryBoundary: string;
  daysRemaining: number;
};

export type OrganizationTrialExpiryInventoryResult = {
  generatedAtIso: string;
  liveOrganizationManagedRows: number;
  wouldSuspend: OrganizationTrialExpiryInventoryItem[];
  beforeHardExpiry: OrganizationTrialExpiryInventoryItem[];
  hardExpiredExcludedByEntitlement: Record<
    OrganizationTrialExpiryInventoryEntitlementReason,
    OrganizationTrialExpiryInventoryItem[]
  >;
};

type OrganizationTrialExpiryInventoryInput = {
  generatedAtIso: string;
  rows: OrganizationTrialExpiryCandidateRow[];
};

function createEntitlementExclusionBuckets(): OrganizationTrialExpiryInventoryResult['hardExpiredExcludedByEntitlement'] {
  return {
    paid_seat_purchase: [],
    oss_sponsorship: [],
    trial_messaging_suppressed: [],
    require_seats_disabled: [],
  };
}

function inventoryItem(
  row: OrganizationTrialExpiryCandidateRow,
  daysRemaining: number
): OrganizationTrialExpiryInventoryItem {
  return {
    subscriptionId: row.id,
    organizationId: row.organization_id,
    instanceId: row.instance_id,
    hardExpiryBoundary: row.hard_expiry_boundary,
    daysRemaining,
  };
}

export function evaluateOrganizationTrialExpiryInventory(
  input: OrganizationTrialExpiryInventoryInput
): OrganizationTrialExpiryInventoryResult {
  const now = new Date(input.generatedAtIso);
  if (Number.isNaN(now.getTime())) {
    throw new Error('Organization trial expiry inventory requires an ISO generatedAtIso value.');
  }

  const wouldSuspend: OrganizationTrialExpiryInventoryItem[] = [];
  const beforeHardExpiry: OrganizationTrialExpiryInventoryItem[] = [];
  const hardExpiredExcludedByEntitlement = createEntitlementExclusionBuckets();

  for (const row of input.rows) {
    const entitlement = classifyOrganizationEntitlement({
      organization: {
        created_at: row.organization_created_at,
        free_trial_end_at: row.organization_free_trial_end_at,
        require_seats: row.organization_require_seats,
        settings: row.organization_settings,
      },
      latestSeatPurchaseStatus: row.latest_seat_purchase_status,
      now,
    });
    const item = inventoryItem(row, entitlement.daysRemaining);

    if (entitlement.isTrialExpiredForEnforcement) {
      wouldSuspend.push(item);
      continue;
    }

    if (entitlement.trialStatus !== 'trial_expired_hard') {
      beforeHardExpiry.push(item);
      continue;
    }

    if (entitlement.bypassReason) {
      hardExpiredExcludedByEntitlement[entitlement.bypassReason].push(item);
    }
  }

  return {
    generatedAtIso: input.generatedAtIso,
    liveOrganizationManagedRows: input.rows.length,
    wouldSuspend,
    beforeHardExpiry,
    hardExpiredExcludedByEntitlement,
  };
}

function identifier(value: string | null): string {
  return value ?? '(missing)';
}

function formatItems(items: OrganizationTrialExpiryInventoryItem[]): string[] {
  if (items.length === 0) {
    return ['  None.'];
  }

  return items.map(
    item =>
      `  - subscriptionId=${item.subscriptionId} organizationId=${identifier(item.organizationId)} instanceId=${identifier(item.instanceId)} hardExpiryBoundary=${item.hardExpiryBoundary} daysRemaining=${item.daysRemaining}`
  );
}

export function formatOrganizationTrialExpiryInventoryReport(
  result: OrganizationTrialExpiryInventoryResult
): string {
  const exclusions = result.hardExpiredExcludedByEntitlement;
  const lines = [
    `Organization KiloClaw trial-expiry inventory generated at ${result.generatedAtIso}`,
    '',
    'Summary',
    `  liveOrganizationManagedRows: ${result.liveOrganizationManagedRows}`,
    `  wouldSuspend: ${result.wouldSuspend.length}`,
    `  hardExpiredExcludedPaidSeatPurchase: ${exclusions.paid_seat_purchase.length}`,
    `  hardExpiredExcludedOssSponsorship: ${exclusions.oss_sponsorship.length}`,
    `  hardExpiredExcludedTrialMessagingSuppressed: ${exclusions.trial_messaging_suppressed.length}`,
    `  hardExpiredExcludedRequireSeatsDisabled: ${exclusions.require_seats_disabled.length}`,
    `  beforeHardExpiry: ${result.beforeHardExpiry.length}`,
    '',
    'Would suspend now',
    ...formatItems(result.wouldSuspend),
    '',
    'Hard-expired but excluded: paid_seat_purchase',
    ...formatItems(exclusions.paid_seat_purchase),
    '',
    'Hard-expired but excluded: oss_sponsorship',
    ...formatItems(exclusions.oss_sponsorship),
    '',
    'Hard-expired but excluded: trial_messaging_suppressed',
    ...formatItems(exclusions.trial_messaging_suppressed),
    '',
    'Hard-expired but excluded: require_seats_disabled',
    ...formatItems(exclusions.require_seats_disabled),
  ];

  return lines.join('\n');
}
