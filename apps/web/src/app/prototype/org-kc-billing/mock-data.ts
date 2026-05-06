/**
 * Mock data for the Org KiloClaw billing UI prototype.
 *
 * Mirrors the shapes defined in `.plans/org-kiloclaw-billing-ui.md`:
 * - PR 1: OrgBillingStatus discriminated union (admin / member)
 * - PR 3: OrgProvisionPreflight discriminated union
 * - Wave A: KiloClawOrgSubscriptionRow + health summary
 *
 * Pure data only — no React, no hooks. The prototype page consumes these
 * fixtures and renders each variant inline.
 */

export type OrgBillingOperationalState =
  | { kind: 'available' }
  | {
      kind: 'trialing';
      trialKind: '7day_user' | '30day_launch';
      endsAt: string;
      daysRemaining: number;
    }
  | { kind: 'past_due'; suspendedAt: string | null }
  | { kind: 'canceling_at_period_end'; endsAt: string }
  | {
      kind: 'blocked_parent_entitlement';
      reason: 'org_trial_hard_expired' | 'org_subscription_ended';
    }
  | { kind: 'blocked_opt_out' };

export type AdminSubscription = {
  instanceId: string;
  subscriptionId: string;
  plan: 'standard';
  status: 'active' | 'trialing' | 'past_due' | 'canceled';
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string;
  creditRenewalAt: string | null;
  renewalCostMicrodollars: number;
  trialEndsAt: string | null;
  isLaunchBackfill: boolean;
  associatedUserId: string;
  associatedUserDisplayName: string;
};

export type AdminBillingStatus = {
  role: 'admin';
  operational: OrgBillingOperationalState;
  subscription: AdminSubscription | null;
  org: {
    creditBalanceMicrodollars: number;
    canTopUp: boolean;
  };
};

export type MemberBillingStatus = {
  role: 'member';
  operational: OrgBillingOperationalState;
};

export type OrgBillingStatus = AdminBillingStatus | MemberBillingStatus;

const baseAdminSub = (): AdminSubscription => ({
  instanceId: 'inst_8f3c2a1d',
  subscriptionId: 'sub_kc_org_92ad17',
  plan: 'standard',
  status: 'active',
  cancelAtPeriodEnd: false,
  currentPeriodEnd: '2026-06-12',
  creditRenewalAt: '2026-06-12',
  renewalCostMicrodollars: 49_000_000, // $49
  trialEndsAt: null,
  isLaunchBackfill: false,
  associatedUserId: 'usr_alice',
  associatedUserDisplayName: 'Alice Chen',
});

export const adminFixtures: Record<string, AdminBillingStatus> = {
  emptyState: {
    role: 'admin',
    operational: { kind: 'available' },
    subscription: null,
    org: { creditBalanceMicrodollars: 250_000_000, canTopUp: true },
  },
  active: {
    role: 'admin',
    operational: { kind: 'available' },
    subscription: baseAdminSub(),
    org: { creditBalanceMicrodollars: 250_000_000, canTopUp: true },
  },
  trialing30day: {
    role: 'admin',
    operational: {
      kind: 'trialing',
      trialKind: '30day_launch',
      endsAt: '2026-06-05',
      daysRemaining: 23,
    },
    subscription: {
      ...baseAdminSub(),
      status: 'trialing',
      isLaunchBackfill: true,
      trialEndsAt: '2026-06-05',
      currentPeriodEnd: '2026-06-05',
      creditRenewalAt: '2026-06-05',
    },
    org: { creditBalanceMicrodollars: 250_000_000, canTopUp: true },
  },
  trialing7day: {
    role: 'admin',
    operational: {
      kind: 'trialing',
      trialKind: '7day_user',
      endsAt: '2026-05-13',
      daysRemaining: 5,
    },
    subscription: {
      ...baseAdminSub(),
      status: 'trialing',
      isLaunchBackfill: false,
      trialEndsAt: '2026-05-13',
      currentPeriodEnd: '2026-05-13',
      creditRenewalAt: '2026-05-13',
    },
    org: { creditBalanceMicrodollars: 250_000_000, canTopUp: true },
  },
  pastDue: {
    role: 'admin',
    operational: { kind: 'past_due', suspendedAt: null },
    subscription: { ...baseAdminSub(), status: 'past_due' },
    org: { creditBalanceMicrodollars: 12_000_000, canTopUp: true },
  },
  pastDueSuspended: {
    role: 'admin',
    operational: { kind: 'past_due', suspendedAt: '2026-05-04T08:13:00Z' },
    subscription: { ...baseAdminSub(), status: 'past_due' },
    org: { creditBalanceMicrodollars: 0, canTopUp: true },
  },
  canceling: {
    role: 'admin',
    operational: { kind: 'canceling_at_period_end', endsAt: '2026-06-12' },
    subscription: { ...baseAdminSub(), cancelAtPeriodEnd: true, status: 'active' },
    org: { creditBalanceMicrodollars: 250_000_000, canTopUp: true },
  },
  blockedParentSubEnded: {
    role: 'admin',
    operational: { kind: 'blocked_parent_entitlement', reason: 'org_subscription_ended' },
    subscription: { ...baseAdminSub(), status: 'canceled' },
    org: { creditBalanceMicrodollars: 0, canTopUp: false },
  },
  blockedParentTrialExpired: {
    role: 'admin',
    operational: { kind: 'blocked_parent_entitlement', reason: 'org_trial_hard_expired' },
    subscription: null,
    org: { creditBalanceMicrodollars: 0, canTopUp: true },
  },
  blockedOptOut: {
    role: 'admin',
    operational: { kind: 'blocked_opt_out' },
    subscription: { ...baseAdminSub(), status: 'active' },
    org: { creditBalanceMicrodollars: 250_000_000, canTopUp: true },
  },
};

export const memberFixtures: Record<string, MemberBillingStatus> = {
  available: { role: 'member', operational: { kind: 'available' } },
  trialing30day: {
    role: 'member',
    operational: {
      kind: 'trialing',
      trialKind: '30day_launch',
      endsAt: '2026-06-05',
      daysRemaining: 23,
    },
  },
  trialing7day: {
    role: 'member',
    operational: {
      kind: 'trialing',
      trialKind: '7day_user',
      endsAt: '2026-05-13',
      daysRemaining: 5,
    },
  },
  pastDue: { role: 'member', operational: { kind: 'past_due', suspendedAt: null } },
  pastDueSuspended: {
    role: 'member',
    operational: { kind: 'past_due', suspendedAt: '2026-05-04T08:13:00Z' },
  },
  canceling: {
    role: 'member',
    operational: { kind: 'canceling_at_period_end', endsAt: '2026-06-12' },
  },
  blockedParentSubEnded: {
    role: 'member',
    operational: { kind: 'blocked_parent_entitlement', reason: 'org_subscription_ended' },
  },
  blockedParentTrialExpired: {
    role: 'member',
    operational: { kind: 'blocked_parent_entitlement', reason: 'org_trial_hard_expired' },
  },
  blockedOptOut: { role: 'member', operational: { kind: 'blocked_opt_out' } },
};

// PR 2 — Banner sub-states
export type OrgBannerSubState =
  | 'trial_active_30day'
  | 'trial_active_7day'
  | 'trial_ending_soon'
  | 'trial_ending_very_soon'
  | 'trial_expires_today'
  | 'past_due_admin_actionable'
  | 'past_due_member_contact_admin'
  | 'canceling'
  | 'blocked_parent'
  | 'blocked_opt_out';

// PR 3 — Provision preflight
export type OrgProvisionPreflight =
  | {
      role: 'admin';
      kind: 'allowed';
      trialEligible: boolean;
      firstPeriodCostMicrodollars: number;
      orgCreditBalanceMicrodollars: number;
    }
  | {
      role: 'member';
      kind: 'allowed';
      trialEligible: boolean;
    }
  | {
      role: 'admin' | 'member';
      kind: 'blocked_parent_entitlement';
      reason: 'no_org_subscription' | 'org_trial_hard_expired' | 'org_subscription_ended';
    }
  | { role: 'admin' | 'member'; kind: 'blocked_opt_out' }
  | {
      role: 'admin' | 'member';
      kind: 'blocked_existing_instance';
      existingInstanceId: string;
      existingInstanceName: string | null;
    }
  | {
      role: 'admin';
      kind: 'blocked_insufficient_credits';
      firstPeriodCostMicrodollars: number;
      orgCreditBalanceMicrodollars: number;
      shortfallMicrodollars: number;
    }
  | { role: 'member'; kind: 'blocked_insufficient_credits' };

export const preflightFixtures: Record<string, OrgProvisionPreflight> = {
  adminAllowedTrialEligible: {
    role: 'admin',
    kind: 'allowed',
    trialEligible: true,
    firstPeriodCostMicrodollars: 49_000_000,
    orgCreditBalanceMicrodollars: 250_000_000,
  },
  adminAllowedNoTrial: {
    role: 'admin',
    kind: 'allowed',
    trialEligible: false,
    firstPeriodCostMicrodollars: 49_000_000,
    orgCreditBalanceMicrodollars: 250_000_000,
  },
  memberAllowedTrialEligible: {
    role: 'member',
    kind: 'allowed',
    trialEligible: true,
  },
  memberAllowedNoTrial: {
    role: 'member',
    kind: 'allowed',
    trialEligible: false,
  },
  blockedParentNoSub: {
    role: 'admin',
    kind: 'blocked_parent_entitlement',
    reason: 'no_org_subscription',
  },
  blockedParentTrialExpired: {
    role: 'admin',
    kind: 'blocked_parent_entitlement',
    reason: 'org_trial_hard_expired',
  },
  blockedParentSubEnded: {
    role: 'member',
    kind: 'blocked_parent_entitlement',
    reason: 'org_subscription_ended',
  },
  blockedOptOutAdmin: { role: 'admin', kind: 'blocked_opt_out' },
  blockedOptOutMember: { role: 'member', kind: 'blocked_opt_out' },
  blockedExistingInstance: {
    role: 'admin',
    kind: 'blocked_existing_instance',
    existingInstanceId: 'inst_8f3c2a1d',
    existingInstanceName: 'alice-dev',
  },
  blockedInsufficientCreditsAdmin: {
    role: 'admin',
    kind: 'blocked_insufficient_credits',
    firstPeriodCostMicrodollars: 49_000_000,
    orgCreditBalanceMicrodollars: 12_000_000,
    shortfallMicrodollars: 37_000_000,
  },
  blockedInsufficientCreditsMember: {
    role: 'member',
    kind: 'blocked_insufficient_credits',
  },
};

// Wave A — Subscription list rows
export type KiloClawOrgSubscriptionRow = {
  instanceId: string;
  instanceName: string | null;
  associatedUserId: string;
  associatedUserDisplayName: string;
  associatedUserEmail: string;
  status: 'active' | 'trialing' | 'past_due' | 'canceled';
  cancelAtPeriodEnd: boolean;
  isLaunchBackfill: boolean;
  trialKind: '7day_user' | '30day_launch' | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string;
  renewalCostMicrodollars: number;
  suspendedAt: string | null;
  operationalKind: OrgBillingOperationalState['kind'];
  // Reason discriminator for `operationalKind === 'blocked_parent_entitlement'`.
  // The detail page renders reason-specific copy in the status note callout.
  // Group/list views ignore this and show only the StatusBadge.
  blockingReason?: 'org_trial_hard_expired' | 'org_subscription_ended' | null;
};

// Detail-page fixtures keyed by operational variant. Separate from the group
// list (`subscriptionRowsFixture`) because blocked variants surface in the
// detail page's status note callout but never appear in the canonical group
// list (canceled instances do, but blocked-parent / blocked-opt-out instances
// retain their existing `status` and surface state via `operationalKind`).
export const detailRowFixtures: Record<string, KiloClawOrgSubscriptionRow> = {
  active: {
    instanceId: 'inst_8f3c2a1d',
    instanceName: 'alice-dev',
    associatedUserId: 'usr_alice',
    associatedUserDisplayName: 'Alice Chen',
    associatedUserEmail: 'alice@kilocode.ai',
    status: 'active',
    cancelAtPeriodEnd: false,
    isLaunchBackfill: false,
    trialKind: null,
    trialEndsAt: null,
    currentPeriodEnd: '2026-06-12',
    renewalCostMicrodollars: 49_000_000,
    suspendedAt: null,
    operationalKind: 'available',
  },
  trialing30day: {
    instanceId: 'inst_a1b2c3d4',
    instanceName: 'bob-staging',
    associatedUserId: 'usr_bob',
    associatedUserDisplayName: 'Bob Martinez',
    associatedUserEmail: 'bob@kilocode.ai',
    status: 'trialing',
    cancelAtPeriodEnd: false,
    isLaunchBackfill: true,
    trialKind: '30day_launch',
    trialEndsAt: '2026-06-05',
    currentPeriodEnd: '2026-06-05',
    renewalCostMicrodollars: 49_000_000,
    suspendedAt: null,
    operationalKind: 'trialing',
  },
  trialing7day: {
    instanceId: 'inst_q7r8s9t0',
    instanceName: 'frank-prototype',
    associatedUserId: 'usr_frank',
    associatedUserDisplayName: 'Frank Yamamoto',
    associatedUserEmail: 'frank@kilocode.ai',
    status: 'trialing',
    cancelAtPeriodEnd: false,
    isLaunchBackfill: false,
    trialKind: '7day_user',
    trialEndsAt: '2026-05-13',
    currentPeriodEnd: '2026-05-13',
    renewalCostMicrodollars: 49_000_000,
    suspendedAt: null,
    operationalKind: 'trialing',
  },
  pastDue: {
    instanceId: 'inst_e5f6g7h8',
    instanceName: 'carol-claw',
    associatedUserId: 'usr_carol',
    associatedUserDisplayName: 'Carol Lee',
    associatedUserEmail: 'carol@kilocode.ai',
    status: 'past_due',
    cancelAtPeriodEnd: false,
    isLaunchBackfill: false,
    trialKind: null,
    trialEndsAt: null,
    currentPeriodEnd: '2026-05-04',
    renewalCostMicrodollars: 49_000_000,
    suspendedAt: null,
    operationalKind: 'past_due',
  },
  canceling: {
    instanceId: 'inst_i9j0k1l2',
    instanceName: 'dan-experiments',
    associatedUserId: 'usr_dan',
    associatedUserDisplayName: 'Dan Roberts',
    associatedUserEmail: 'dan@kilocode.ai',
    status: 'active',
    cancelAtPeriodEnd: true,
    isLaunchBackfill: false,
    trialKind: null,
    trialEndsAt: null,
    currentPeriodEnd: '2026-06-12',
    renewalCostMicrodollars: 49_000_000,
    suspendedAt: null,
    operationalKind: 'canceling_at_period_end',
  },
  blockedParentSubEnded: {
    instanceId: 'inst_u1v2w3x4',
    instanceName: 'grace-platform',
    associatedUserId: 'usr_grace',
    associatedUserDisplayName: 'Grace Park',
    associatedUserEmail: 'grace@kilocode.ai',
    status: 'active',
    cancelAtPeriodEnd: false,
    isLaunchBackfill: false,
    trialKind: null,
    trialEndsAt: null,
    currentPeriodEnd: '2026-06-01',
    renewalCostMicrodollars: 49_000_000,
    suspendedAt: null,
    operationalKind: 'blocked_parent_entitlement',
    blockingReason: 'org_subscription_ended',
  },
  blockedParentTrialExpired: {
    instanceId: 'inst_y5z6a7b8',
    instanceName: 'henry-research',
    associatedUserId: 'usr_henry',
    associatedUserDisplayName: 'Henry Olsen',
    associatedUserEmail: 'henry@kilocode.ai',
    status: 'active',
    cancelAtPeriodEnd: false,
    isLaunchBackfill: false,
    trialKind: null,
    trialEndsAt: null,
    currentPeriodEnd: '2026-06-01',
    renewalCostMicrodollars: 49_000_000,
    suspendedAt: null,
    operationalKind: 'blocked_parent_entitlement',
    blockingReason: 'org_trial_hard_expired',
  },
  blockedOptOut: {
    instanceId: 'inst_c9d0e1f2',
    instanceName: 'iris-tooling',
    associatedUserId: 'usr_iris',
    associatedUserDisplayName: 'Iris Sokolov',
    associatedUserEmail: 'iris@kilocode.ai',
    status: 'active',
    cancelAtPeriodEnd: false,
    isLaunchBackfill: false,
    trialKind: null,
    trialEndsAt: null,
    currentPeriodEnd: '2026-06-01',
    renewalCostMicrodollars: 49_000_000,
    suspendedAt: null,
    operationalKind: 'blocked_opt_out',
  },
};

export const subscriptionRowsFixture: KiloClawOrgSubscriptionRow[] = [
  {
    instanceId: 'inst_8f3c2a1d',
    instanceName: 'alice-dev',
    associatedUserId: 'usr_alice',
    associatedUserDisplayName: 'Alice Chen',
    associatedUserEmail: 'alice@kilocode.ai',
    status: 'active',
    cancelAtPeriodEnd: false,
    isLaunchBackfill: false,
    trialKind: null,
    trialEndsAt: null,
    currentPeriodEnd: '2026-06-12',
    renewalCostMicrodollars: 49_000_000,
    suspendedAt: null,
    operationalKind: 'available',
  },
  {
    instanceId: 'inst_a1b2c3d4',
    instanceName: 'bob-staging',
    associatedUserId: 'usr_bob',
    associatedUserDisplayName: 'Bob Martinez',
    associatedUserEmail: 'bob@kilocode.ai',
    status: 'trialing',
    cancelAtPeriodEnd: false,
    isLaunchBackfill: true,
    trialKind: '30day_launch',
    trialEndsAt: '2026-06-05',
    currentPeriodEnd: '2026-06-05',
    renewalCostMicrodollars: 49_000_000,
    suspendedAt: null,
    operationalKind: 'trialing',
  },
  {
    instanceId: 'inst_e5f6g7h8',
    instanceName: 'carol-claw',
    associatedUserId: 'usr_carol',
    associatedUserDisplayName: 'Carol Lee',
    associatedUserEmail: 'carol@kilocode.ai',
    status: 'past_due',
    cancelAtPeriodEnd: false,
    isLaunchBackfill: false,
    trialKind: null,
    trialEndsAt: null,
    currentPeriodEnd: '2026-05-04',
    renewalCostMicrodollars: 49_000_000,
    suspendedAt: null,
    operationalKind: 'past_due',
  },
  {
    instanceId: 'inst_i9j0k1l2',
    instanceName: 'dan-experiments',
    associatedUserId: 'usr_dan',
    associatedUserDisplayName: 'Dan Roberts',
    associatedUserEmail: 'dan@kilocode.ai',
    status: 'active',
    cancelAtPeriodEnd: true,
    isLaunchBackfill: false,
    trialKind: null,
    trialEndsAt: null,
    currentPeriodEnd: '2026-06-12',
    renewalCostMicrodollars: 49_000_000,
    suspendedAt: null,
    operationalKind: 'canceling_at_period_end',
  },
  {
    instanceId: 'inst_m3n4o5p6',
    instanceName: 'eve-old',
    associatedUserId: 'usr_eve',
    associatedUserDisplayName: 'Eve Kowalski',
    associatedUserEmail: 'eve@kilocode.ai',
    status: 'canceled',
    cancelAtPeriodEnd: false,
    isLaunchBackfill: false,
    trialKind: null,
    trialEndsAt: null,
    currentPeriodEnd: '2026-04-01',
    renewalCostMicrodollars: 49_000_000,
    suspendedAt: '2026-04-01T00:00:00Z',
    operationalKind: 'available',
  },
];

// Wave A — Health summary
export type OrgKiloclawHealthSummary = {
  pastDueCount: number;
  suspendedCount: number;
  canceledByParentEntitlementCount: number;
  blockedByOptOutCount: number;
  totalActiveCount: number;
};

export const healthSummaryFixtures: Record<string, OrgKiloclawHealthSummary> = {
  healthy: {
    pastDueCount: 0,
    suspendedCount: 0,
    canceledByParentEntitlementCount: 0,
    blockedByOptOutCount: 0,
    totalActiveCount: 6,
  },
  pastDueOnly: {
    pastDueCount: 2,
    suspendedCount: 0,
    canceledByParentEntitlementCount: 0,
    blockedByOptOutCount: 0,
    totalActiveCount: 8,
  },
  multipleIssues: {
    pastDueCount: 3,
    suspendedCount: 1,
    canceledByParentEntitlementCount: 2,
    blockedByOptOutCount: 0,
    totalActiveCount: 12,
  },
};

// Wave A — Billing history entries
export type CreditBillingEntry = {
  id: string;
  date: string;
  description: string;
  amountMicrodollars: number;
};

export const billingHistoryFixture: CreditBillingEntry[] = [
  {
    id: 'bh_1',
    date: '2026-05-12',
    description: 'KiloClaw renewal — alice-dev',
    amountMicrodollars: -49_000_000,
  },
  {
    id: 'bh_2',
    date: '2026-04-12',
    description: 'KiloClaw renewal — alice-dev',
    amountMicrodollars: -49_000_000,
  },
  {
    id: 'bh_3',
    date: '2026-03-12',
    description: 'KiloClaw renewal — alice-dev',
    amountMicrodollars: -49_000_000,
  },
  {
    id: 'bh_4',
    date: '2026-02-12',
    description: 'KiloClaw provisioned — alice-dev (free trial)',
    amountMicrodollars: 0,
  },
];

// Wave C — Associated user
export type AssociatedUser = { id: string; displayName: string; email: string };

export const associatedUserFixtures = {
  someoneElse: {
    id: 'usr_alice',
    displayName: 'Alice Chen',
    email: 'alice@kilocode.ai',
  } satisfies AssociatedUser,
  yourself: {
    id: 'usr_viewer',
    displayName: 'You (Bob Martinez)',
    email: 'bob@kilocode.ai',
  } satisfies AssociatedUser,
};

export const VIEWER_USER_ID = 'usr_viewer';

// Helpers
export function formatMicrodollars(microdollars: number): string {
  const dollars = microdollars / 1_000_000;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(dollars);
}

export function formatDate(iso: string | null | undefined, fallback = '—'): string {
  if (!iso) return fallback;
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
