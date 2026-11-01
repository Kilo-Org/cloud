import type { KiloClawSubscriptionStatus } from '@kilocode/db/schema-types';

export type ImmediateKiloClawCancellationDecision = 'cancel' | 'not_needed';

type StripeScheduleReference = string | { id: string } | null | undefined;

type HostingCancellationSubscription = {
  id: string;
  status: KiloClawSubscriptionStatus;
  transferred_to_subscription_id: string | null;
  pending_conversion: boolean;
  stripe_subscription_id: string | null;
  stripe_schedule_id: string | null;
};

export type BulkHostingCancellationOutcome =
  | { status: 'canceled'; subscriptionIds: string[] }
  | { status: 'not_needed' }
  | { status: 'failed'; error: string };

export async function cancelKiloClawHostingImmediately(params: {
  prepare: () => Promise<{
    subscription: HostingCancellationSubscription | null;
    clearedPendingConversion: boolean;
  }>;
  cancelStripe: (
    subscriptionId: string,
    scheduleId: string | null
  ) => Promise<'canceled' | 'not_needed'>;
  reconcile: (subscription: HostingCancellationSubscription) => Promise<boolean>;
}): Promise<BulkHostingCancellationOutcome> {
  try {
    const { subscription, clearedPendingConversion } = await params.prepare();
    if (!subscription || subscription.transferred_to_subscription_id) {
      return { status: 'not_needed' };
    }
    if (
      decideImmediateKiloClawCancellation({
        status: subscription.status,
        transferredToSubscriptionId: subscription.transferred_to_subscription_id,
        pendingConversion: subscription.pending_conversion,
      }) === 'not_needed' &&
      !subscription.stripe_subscription_id &&
      !clearedPendingConversion
    ) {
      return { status: 'not_needed' };
    }

    const providerCanceled = subscription.stripe_subscription_id
      ? (await params.cancelStripe(
          subscription.stripe_subscription_id,
          subscription.stripe_schedule_id
        )) === 'canceled'
      : false;
    const locallyCanceled = await params.reconcile(subscription);
    return providerCanceled || locallyCanceled || clearedPendingConversion
      ? { status: 'canceled', subscriptionIds: [subscription.id] }
      : { status: 'not_needed' };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : 'hosting cancellation failed',
    };
  }
}

export async function cancelStripeHostingImmediately(params: {
  stripeSubscriptionId: string;
  storedScheduleId: string | null;
  retrieve: (
    subscriptionId: string
  ) => Promise<{ status: string; schedule: StripeScheduleReference }>;
  releaseSchedule: (scheduleId: string) => Promise<unknown>;
  cancel: (
    subscriptionId: string,
    options: { prorate: false; invoice_now: false }
  ) => Promise<unknown>;
  isInactiveScheduleError: (error: unknown) => boolean;
}): Promise<'canceled' | 'not_needed'> {
  const subscription = await params.retrieve(params.stripeSubscriptionId);
  if (subscription.status === 'canceled') return 'not_needed';

  const scheduleId =
    (typeof subscription.schedule === 'string'
      ? subscription.schedule
      : subscription.schedule?.id) ??
    params.storedScheduleId ??
    null;
  if (scheduleId) {
    try {
      await params.releaseSchedule(scheduleId);
    } catch (error) {
      if (!params.isInactiveScheduleError(error)) throw error;
    }
  }

  try {
    await params.cancel(params.stripeSubscriptionId, { prorate: false, invoice_now: false });
  } catch (error) {
    const current = await params.retrieve(params.stripeSubscriptionId).catch(() => null);
    if (current?.status !== 'canceled') throw error;
  }
  return 'canceled';
}

export function decideImmediateKiloClawCancellation(params: {
  status: KiloClawSubscriptionStatus;
  transferredToSubscriptionId: string | null;
  pendingConversion: boolean;
}): ImmediateKiloClawCancellationDecision {
  if (
    params.transferredToSubscriptionId ||
    (params.status === 'canceled' && !params.pendingConversion)
  ) {
    return 'not_needed';
  }

  return 'cancel';
}
