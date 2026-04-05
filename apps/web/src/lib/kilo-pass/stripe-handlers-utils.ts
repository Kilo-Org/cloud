import { computeIssueMonth } from '@/lib/kilo-pass/issuance';
import { dayjs } from '@/lib/kilo-pass/dayjs';
import type Stripe from 'stripe';

/**
 * Adds one month to an issue month string (YYYY-MM-01 format).
 */
export function addOneMonthToIssueMonth(issueMonth: string): string {
  const parsed = dayjs(`${issueMonth}T00:00:00.000Z`).utc();
  if (!parsed.isValid()) {
    throw new Error(`Invalid issueMonth: ${issueMonth}`);
  }

  return computeIssueMonth(parsed.add(1, 'month'));
}

/**
 * Gets the previous issue month from an issue month string (YYYY-MM-01 format).
 */
export function getPreviousIssueMonth(issueMonth: string): string {
  const parsed = dayjs(`${issueMonth}T00:00:00.000Z`).utc();
  if (!parsed.isValid()) {
    throw new Error(`Invalid issueMonth: ${issueMonth}`);
  }

  return computeIssueMonth(parsed.subtract(1, 'month'));
}

/**
 * Returns the period.start of the first subscription line item, which represents
 * the actual service period being billed. invoice.period_start is NOT suitable
 * because Stripe documents it as looking back one period for subscription invoices.
 */
function getSubscriptionLineItemPeriodStart(invoice: Stripe.Invoice): number | null {
  const lines = invoice.lines?.data ?? [];
  for (const line of lines) {
    const details = line.parent?.subscription_item_details;
    if (details && !details.proration) {
      return line.period.start;
    }
  }
  return null;
}

/**
 * Extracts the issue month from a Stripe invoice using the subscription line item's
 * service period. Falls back to invoice.created for non-subscription invoices.
 */
export function getInvoiceIssueMonth(invoice: Stripe.Invoice): string {
  const lineItemPeriodStart = getSubscriptionLineItemPeriodStart(invoice);
  const seconds = lineItemPeriodStart ?? invoice.created ?? null;
  if (seconds === null) {
    throw new Error(
      `Invoice ${invoice.id} has no subscription line item period and no created timestamp`
    );
  }

  return computeIssueMonth(dayjs.unix(seconds).utc());
}

/**
 * Retrieves the latest Stripe subscription from an invoice.
 * Always fetches from Stripe API to ensure we have the current state,
 * not a potentially stale snapshot embedded in the webhook event.
 */
export async function getInvoiceSubscription(params: {
  invoice: Stripe.Invoice;
  stripe: Stripe;
}): Promise<Stripe.Subscription | null> {
  const { invoice, stripe } = params;

  const subscriptionUnion = invoice.parent?.subscription_details?.subscription;

  if (!subscriptionUnion) return null;

  const subscriptionId =
    typeof subscriptionUnion === 'string' ? subscriptionUnion : subscriptionUnion.id;

  return await stripe.subscriptions.retrieve(subscriptionId);
}

/**
 * Gets the ended_at timestamp from a Stripe subscription as an ISO string.
 * Falls back to current time if no ended_at or canceled_at is available.
 */
export function getStripeEndedAtIso(subscription: Stripe.Subscription): string {
  const seconds = subscription.ended_at ?? subscription.canceled_at ?? null;
  if (seconds != null) {
    return dayjs.unix(seconds).utc().toISOString();
  }
  return dayjs().utc().toISOString();
}
