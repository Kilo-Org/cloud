export type OrgKiloPassTier = 'tier_19' | 'tier_49' | 'tier_199';
export type OrgKiloPassCadence = 'monthly' | 'annual';
export type OrgKiloPassCommercialState =
  | 'pending_payment'
  | 'active'
  | 'cancel_at_period_end'
  | 'ended';
export type OrgKiloPassBonusState =
  | 'locked'
  | 'unlocked'
  | 'upfront_granted'
  | 'expired'
  | 'missed';

/**
 * Versioned display terms for one organization Pass tier. The summary, setup,
 * and detail API outputs each carry these so the UI renders the agreed terms
 * rather than deriving them from the tier key.
 */
export type OrgKiloPassTerms = {
  tier: OrgKiloPassTier;
  tierName: string;
  pricePerPassUsd: number;
  baseCreditsPerPassUsd: number;
  bonusCreditsPerPassUsd: number;
  unlockSpendPerPassUsd: number;
  bonusMode: 'after_base' | 'upfront';
};

export type OrgKiloPassAllocation = {
  organizationId: string;
  organizationName: string;
  kind: 'parent' | 'child';
  passCount: number;
  hasProratedCredits?: boolean;
  baseCreditsUsd?: number;
  qualifyingSpendUsd?: number;
  unlockTargetUsd?: number;
  bonusCreditsUsd?: number;
  bonusState?: OrgKiloPassBonusState;
};

export type OrgKiloPassCondition = {
  kind: 'manual' | 'blocked' | 'overallocated' | 'failed' | 'payment_review';
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  actionBusy?: boolean;
};

/** Plan change controls for an organization's Kilo Pass, shown on the detail view. */
export type OrgKiloPassTierChange = {
  currentTier: OrgKiloPassTier;
  availableTerms: OrgKiloPassTerms[];
  /** Why the tier cannot change now; absent when the change is allowed. */
  blockedReason?: string;
  pending?: { terms: OrgKiloPassTerms; effectiveAt: string };
  onChangeTier: (tier: OrgKiloPassTier) => void;
  onCancelPendingChange: () => void;
};
