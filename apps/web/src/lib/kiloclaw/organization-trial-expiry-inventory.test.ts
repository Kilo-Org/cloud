import type { OrganizationTrialExpiryCandidateRow } from '@kilocode/db/kiloclaw-organization-trial-expiry-candidates';

import {
  evaluateOrganizationTrialExpiryInventory,
  formatOrganizationTrialExpiryInventoryReport,
} from './organization-trial-expiry-inventory';

const generatedAtIso = '2026-05-19T00:00:00.000Z';

function candidateRow(
  overrides: Partial<OrganizationTrialExpiryCandidateRow> = {}
): OrganizationTrialExpiryCandidateRow {
  return {
    id: 'subscription-would-suspend',
    user_id: 'user-1',
    instance_id: 'instance-1',
    sandbox_id: 'sandbox-1',
    instance_destroyed_at: null,
    instance_name: 'Rollout Claw',
    plan: 'standard',
    organization_id: 'organization-1',
    organization_name: 'Example Org',
    organization_created_at: '2026-04-01T00:00:00.000Z',
    organization_free_trial_end_at: '2026-04-15T00:00:00.000Z',
    organization_require_seats: true,
    organization_settings: {},
    latest_seat_purchase_status: null,
    hard_expiry_boundary: '2026-04-18T00:00:00.000Z',
    email: 'private-user@example.com',
    ...overrides,
  };
}

describe('organization KiloClaw trial expiry inventory', () => {
  it('groups hard-expired unentitled rows, entitled exclusions, and rows before hard expiry', () => {
    const result = evaluateOrganizationTrialExpiryInventory({
      generatedAtIso,
      rows: [
        candidateRow(),
        candidateRow({
          id: 'subscription-paid',
          instance_id: 'instance-paid',
          organization_id: 'organization-paid',
          latest_seat_purchase_status: 'active',
        }),
        candidateRow({
          id: 'subscription-oss',
          instance_id: 'instance-oss',
          organization_id: 'organization-oss',
          organization_settings: { oss_sponsorship_tier: 1 },
        }),
        candidateRow({
          id: 'subscription-suppressed',
          instance_id: 'instance-suppressed',
          organization_id: 'organization-suppressed',
          organization_settings: { suppress_trial_messaging: true },
        }),
        candidateRow({
          id: 'subscription-require-seats-disabled',
          instance_id: 'instance-require-seats-disabled',
          organization_id: 'organization-require-seats-disabled',
          organization_require_seats: false,
        }),
        candidateRow({
          id: 'subscription-before-hard-expiry',
          instance_id: 'instance-before-hard-expiry',
          organization_id: 'organization-before-hard-expiry',
          organization_free_trial_end_at: '2026-05-20T00:00:00.000Z',
          hard_expiry_boundary: '2026-05-23T00:00:00.000Z',
        }),
      ],
    });

    expect(result.liveOrganizationManagedRows).toBe(6);
    expect(result.wouldSuspend.map(item => item.subscriptionId)).toEqual([
      'subscription-would-suspend',
    ]);
    expect(result.hardExpiredExcludedByEntitlement.paid_seat_purchase).toHaveLength(1);
    expect(result.hardExpiredExcludedByEntitlement.oss_sponsorship).toHaveLength(1);
    expect(result.hardExpiredExcludedByEntitlement.trial_messaging_suppressed).toHaveLength(1);
    expect(result.hardExpiredExcludedByEntitlement.require_seats_disabled).toHaveLength(1);
    expect(result.beforeHardExpiry.map(item => item.subscriptionId)).toEqual([
      'subscription-before-hard-expiry',
    ]);
  });

  it('formats support-friendly output without email or organization-name disclosure', () => {
    const result = evaluateOrganizationTrialExpiryInventory({
      generatedAtIso,
      rows: [
        candidateRow(),
        candidateRow({
          id: 'subscription-paid',
          organization_id: 'organization-paid',
          instance_id: 'instance-paid',
          latest_seat_purchase_status: 'past_due',
        }),
      ],
    });

    const report = formatOrganizationTrialExpiryInventoryReport(result);

    expect(report).toContain('wouldSuspend: 1');
    expect(report).toContain('hardExpiredExcludedPaidSeatPurchase: 1');
    expect(report).toContain('subscriptionId=subscription-would-suspend');
    expect(report).toContain('subscriptionId=subscription-paid');
    expect(report).not.toContain('private-user@example.com');
    expect(report).not.toContain('Example Org');
  });
});
