type PlanChangeSubscription = {
  status: string;
  cancelAtPeriodEnd: boolean;
};

export function canSchedulePlanChange(subscription: PlanChangeSubscription): boolean {
  return subscription.status === 'active';
}

export function willWithdrawCancellation(
  subscription: PlanChangeSubscription,
  hasScheduledChange: boolean
): boolean {
  return (
    canSchedulePlanChange(subscription) && subscription.cancelAtPeriodEnd && !hasScheduledChange
  );
}

export function getCancellationWithdrawalNotice(params: {
  effectiveAtLabel: string | null;
}): string {
  const when = params.effectiveAtLabel ?? 'your next billing date';
  return `Your Kilo Pass is set to cancel. Scheduling a change keeps it active instead, and you will be billed for the new plan on ${when}.`;
}
