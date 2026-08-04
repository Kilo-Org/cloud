// Provider-aware Coding Plan UI state helpers. Backend checks remain
// authoritative; these helpers only prevent avoidable failed purchase attempts
// and pick the right customer-facing copy per provider.

export type CodingPlanByokKeyLike = {
  provider_id: string;
  management_source: string;
};

export type CodingPlanPurchaseBlocker = {
  isBlocked: boolean;
  hasLiveSubscription: boolean;
  hasAnyKey: boolean;
  hasManagedKey: boolean;
  hasUserManagedKey: boolean;
};

// Any personal BYOK key in the provider's slot, including a disabled key,
// blocks purchasing a Coding Plan for that provider.
export function getCodingPlanPurchaseBlocker(params: {
  providerId: string;
  byokKeys: readonly CodingPlanByokKeyLike[];
  liveProviderIds: ReadonlySet<string>;
}): CodingPlanPurchaseBlocker {
  const providerKeys = params.byokKeys.filter(key => key.provider_id === params.providerId);
  const hasLiveSubscription = params.liveProviderIds.has(params.providerId);
  const hasAnyKey = providerKeys.length > 0;
  const hasManagedKey = providerKeys.some(key => key.management_source === 'coding_plan');
  const hasUserManagedKey = providerKeys.some(key => key.management_source !== 'coding_plan');

  return {
    isBlocked: hasLiveSubscription || hasAnyKey,
    hasLiveSubscription,
    hasAnyKey,
    hasManagedKey,
    hasUserManagedKey,
  };
}

export type CodingPlanAccessNoticeVariant =
  | 'live_subscription'
  | 'managed_key'
  | 'user_managed_key'
  | 'generic';

// Picks which explanation a blocked provider's notice shows, in priority order.
export function getCodingPlanAccessNoticeVariant(
  blocker: Pick<
    CodingPlanPurchaseBlocker,
    'hasLiveSubscription' | 'hasManagedKey' | 'hasUserManagedKey'
  >
): CodingPlanAccessNoticeVariant {
  if (blocker.hasLiveSubscription) return 'live_subscription';
  if (blocker.hasManagedKey) return 'managed_key';
  if (blocker.hasUserManagedKey) return 'user_managed_key';
  return 'generic';
}

// Read-only label shown on the BYOK page for a Coding Plan-managed key. Some
// direct BYOK provider display names already include "Coding Plan" (for
// example "BytePlus Coding Plan"), so only append it when missing.
export function getCodingPlanManagedKeyLabel(providerDisplayName: string): string {
  const planLabel = providerDisplayName.endsWith('Coding Plan')
    ? providerDisplayName
    : `${providerDisplayName} Coding Plan`;
  return `Managed by ${planLabel}. This key is read-only.`;
}
