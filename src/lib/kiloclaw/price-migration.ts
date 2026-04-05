import type Stripe from 'stripe';

export const LIVE_KILOCLAW_MIGRATION_STATUSES = ['active', 'past_due', 'unpaid'] as const;

type ClawPlan = 'commit' | 'standard';

export function getExpectedSchedulePriceIds(params: {
  currentPlan: ClawPlan;
  scheduledPlan: ClawPlan;
  newPriceIds: Record<ClawPlan, string>;
}) {
  return [params.newPriceIds[params.currentPlan], params.newPriceIds[params.scheduledPlan]];
}

export function getSchedulePhasePriceIds(schedule: Pick<Stripe.SubscriptionSchedule, 'phases'>) {
  return schedule.phases.map(phase => {
    const price = phase.items?.[0]?.price;
    if (!price) return null;
    return typeof price === 'string' ? price : price.id;
  });
}

export function buildUpdatedSchedulePhases(params: {
  schedule: Pick<Stripe.SubscriptionSchedule, 'phases'>;
  currentPlan: ClawPlan;
  scheduledPlan: ClawPlan;
  newPriceIds: Record<ClawPlan, string>;
}) {
  const targetPhasePriceIds = getExpectedSchedulePriceIds({
    currentPlan: params.currentPlan,
    scheduledPlan: params.scheduledPlan,
    newPriceIds: params.newPriceIds,
  });

  return params.schedule.phases.map((phase, index) => ({
    items: [
      { price: targetPhasePriceIds[index] ?? targetPhasePriceIds[targetPhasePriceIds.length - 1] },
    ],
    ...(phase.start_date ? { start_date: phase.start_date } : {}),
    ...(phase.end_date ? { end_date: phase.end_date } : {}),
    ...(phase.proration_behavior ? { proration_behavior: phase.proration_behavior } : {}),
    ...(phase.billing_cycle_anchor ? { billing_cycle_anchor: phase.billing_cycle_anchor } : {}),
    ...(phase.trial_end ? { trial_end: phase.trial_end } : {}),
  }));
}
