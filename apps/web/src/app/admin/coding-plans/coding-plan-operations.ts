// Provider-aware copy helpers for the Coding Plans admin operations page.
// Provider names resolve from the Coding Plan catalog; historical or unknown
// rows fall back to the raw provider ID so operations copy never names the
// wrong provider.

export type CodingPlanProviderNameSource = {
  providerId: string;
  providerName: string;
};

export function getCodingPlanProviderDisplayName(
  catalog: readonly CodingPlanProviderNameSource[],
  providerId: string
): string {
  return catalog.find(entry => entry.providerId === providerId)?.providerName ?? providerId;
}

export function getRevocationCompleteToast(providerDisplayName: string | null): string {
  return providerDisplayName
    ? `${providerDisplayName} credential removed from stock.`
    : 'Credential removed from stock.';
}

export function getReplacementCompleteToast(providerDisplayName: string | null): string {
  return providerDisplayName
    ? `${providerDisplayName} credential replaced and returned to stock.`
    : 'Credential replaced and returned to stock.';
}

export function getRevocationDialogCopy(providerDisplayName: string): {
  title: string;
  description: string;
} {
  return {
    title: `Revoke ${providerDisplayName} credential?`,
    description: `Use this only when ${providerDisplayName} access should be completely removed from stock. Kilo records the plan ID as revoked and keeps this credential unavailable for reuse.`,
  };
}

export function getReplacementDialogCopy(providerDisplayName: string): {
  title: string;
  description: string;
  placeholder: string;
} {
  return {
    title: `Replace ${providerDisplayName} API key`,
    description: `Paste the newly generated ${providerDisplayName} API key for this same upstream plan ID. Kilo validates the key before returning this plan to available inventory.`,
    placeholder: `Paste new ${providerDisplayName} API key`,
  };
}

export function getInventoryReplacementCompleteToast(): string {
  return 'Inventory credential replaced.';
}

export function getInventoryReplacementDialogCopy(inventoryKeyId?: string): {
  title: string;
  description: string;
  placeholder: string;
} {
  const target = inventoryKeyId?.trim() ? ` ${inventoryKeyId.trim()}` : '';
  return {
    title: 'Replace inventory API key',
    description: `Kilo validates the replacement key for inventory ID${target}, encrypts it, and rotates the stored available or assigned key plus any assigned BYOK copy for a live subscription.`,
    placeholder: 'Paste replacement API key',
  };
}

export function canSubmitExtensionDays(value: string): boolean {
  const days = Number(value);
  return Number.isInteger(days) && days >= 1 && days <= 90;
}

export function getCancelSubscriptionDialogCopy(userName: string): {
  title: string;
  description: string;
} {
  return {
    title: `Cancel ${userName}'s subscription?`,
    description:
      'This stops renewal at the end of the current paid period. Access stays active until that date.',
  };
}

export function getExtendSubscriptionDialogCopy(userName: string): {
  title: string;
  description: string;
} {
  return {
    title: `Extend ${userName}'s current period?`,
    description: 'Adds days to the current period end and renewal date without charging credits.',
  };
}

export type InsightsRangeDays = 7 | 14 | 30;

export type AdminSubscriptionSummary = {
  total: number;
  active: number;
  pendingCancellation: number;
  pastDue: number;
};

export type AdminInsightsTotals = {
  liveSubscriptions: number;
  pendingCancellation: number;
  pastDue: number;
  mrrKiloCredits: number;
  revenueAtRiskKiloCredits: number;
  pastDueMrrKiloCredits: number;
  createdInRange: number;
  createdInPriorRange: number;
  canceledInRange: number;
  liveAtRangeStart: number;
  retainedFromRangeStart: number;
  currentWaitersJoinedInRange: number;
  currentWaitersJoinedInPriorRange: number;
  currentWaitlistTotal: number;
};

export type AdminPlanInsight = {
  planId: string;
  liveSubscriptions: number;
  monthlyRecurringValueKiloCredits: number;
  createdInRange: number;
  canceledInRange: number;
  currentWaitersJoinedInRange: number;
  currentWaitlistTotal: number;
};

export type AdminInsightsCatalogItem = {
  planId: string;
  planName: string;
  providerName: string;
};

export type AdminInsightsInventoryCount = {
  planId: string;
  status: string;
  count: number;
};

export type AdminInsightsKpiItem = {
  label: string;
  value: string;
  detail: string;
};

export type AdminPlanPerformanceRow = {
  planId: string;
  planName: string;
  providerName: string;
  activeSubscriptions: number;
  monthlyRecurringValue: number;
  newSubscriptionsInRange: number;
  canceledSubscriptionsInRange: number;
  availableCredentials: number;
  waitlistIntents: number;
  currentWaitersJoinedInRange: number;
};

export function getSubscriptionSummaryItems(
  summary: AdminSubscriptionSummary
): Array<{ label: string; count: number }> {
  return [
    { label: 'Total subscriptions', count: summary.total },
    { label: 'Active subscriptions', count: summary.active },
    { label: 'Cancellation pending', count: summary.pendingCancellation },
    { label: 'Past due subscriptions', count: summary.pastDue },
  ];
}

export function getCodingPlanInsights(
  totals: AdminInsightsTotals,
  rangeDays: InsightsRangeDays
): AdminInsightsKpiItem[] {
  const rangeLabel = `${rangeDays}-day`;
  const rangeDetailLabel = `last ${rangeDays} days`;
  const priorRangeDetailLabel = `prior ${rangeDays} days`;
  const periodGrowthRate = calculateRate(
    totals.createdInRange - totals.canceledInRange,
    totals.createdInPriorRange
  );
  const retentionRate = calculateRate(totals.retainedFromRangeStart, totals.liveAtRangeStart);
  const churnRate = calculateRate(totals.canceledInRange, totals.liveAtRangeStart);

  return [
    {
      label: 'Active MRR',
      value: formatCurrencyValue(totals.mrrKiloCredits),
      detail: `${totals.liveSubscriptions} live subscription${totals.liveSubscriptions === 1 ? '' : 's'}`,
    },
    {
      label: `${rangeLabel} growth`,
      value: formatPercentValue(periodGrowthRate),
      detail: `${formatSignedCount(totals.createdInRange - totals.canceledInRange)} net in ${rangeDetailLabel}`,
    },
    {
      label: `${rangeLabel} retention`,
      value: formatPercentValue(retentionRate),
      detail: `${totals.retainedFromRangeStart}/${totals.liveAtRangeStart} retained from ${rangeDays} days ago`,
    },
    {
      label: `${rangeLabel} churn`,
      value: formatPercentValue(churnRate),
      detail: `${totals.canceledInRange} canceled in ${rangeDetailLabel}`,
    },
    {
      label: 'Revenue at risk',
      value: formatCurrencyValue(totals.revenueAtRiskKiloCredits),
      detail: `${totals.pendingCancellation} canceling, ${totals.pastDue} past due`,
    },
    {
      label: 'New subscriptions',
      value: formatIntegerValue(totals.createdInRange),
      detail: `${totals.createdInPriorRange} created in ${priorRangeDetailLabel}`,
    },
    {
      label: 'Cancellation pending',
      value: formatPercentValue(
        calculateRate(totals.pendingCancellation, totals.liveSubscriptions)
      ),
      detail: `${totals.pendingCancellation}/${totals.liveSubscriptions} live subscriptions`,
    },
    {
      label: 'Past due exposure',
      value: formatCurrencyValue(totals.pastDueMrrKiloCredits),
      detail: `${totals.pastDue} subscription${totals.pastDue === 1 ? '' : 's'} in recovery`,
    },
    {
      label: `Current waiters joined (${rangeLabel})`,
      value: formatIntegerValue(totals.currentWaitersJoinedInRange),
      detail: `${totals.currentWaitersJoinedInPriorRange} current waiters joined in ${priorRangeDetailLabel} · ${totals.currentWaitlistTotal} currently waiting`,
    },
  ];
}

export function getPlanPerformanceRows({
  catalog,
  inventoryCounts,
  planInsights,
}: {
  catalog: readonly AdminInsightsCatalogItem[];
  inventoryCounts: readonly AdminInsightsInventoryCount[];
  planInsights: readonly AdminPlanInsight[];
}): AdminPlanPerformanceRow[] {
  return catalog.map(plan => {
    const insight = planInsights.find(item => item.planId === plan.planId);
    const availableCredentials = inventoryCounts
      .filter(item => item.planId === plan.planId && item.status === 'available')
      .reduce((total, item) => total + item.count, 0);

    return {
      planId: plan.planId,
      planName: plan.planName,
      providerName: plan.providerName,
      activeSubscriptions: insight?.liveSubscriptions ?? 0,
      monthlyRecurringValue: insight?.monthlyRecurringValueKiloCredits ?? 0,
      newSubscriptionsInRange: insight?.createdInRange ?? 0,
      canceledSubscriptionsInRange: insight?.canceledInRange ?? 0,
      availableCredentials,
      waitlistIntents: insight?.currentWaitlistTotal ?? 0,
      currentWaitersJoinedInRange: insight?.currentWaitersJoinedInRange ?? 0,
    };
  });
}

function calculateRate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function formatCurrencyValue(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function formatPercentValue(value: number | null): string {
  if (value === null) {
    return '—';
  }

  return value.toLocaleString('en-US', {
    style: 'percent',
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  });
}

function formatIntegerValue(value: number): string {
  return value.toLocaleString('en-US');
}

function formatSignedCount(value: number): string {
  return value > 0 ? `+${formatIntegerValue(value)}` : formatIntegerValue(value);
}
