import { APP_URL } from '@/lib/constants';
import { KiloPassPaymentProvider } from '@/lib/kilo-pass/enums';
import { getKiloPassStateForUser } from '@/lib/kilo-pass/state';
import { isStripeSubscriptionEnded } from '@/lib/kilo-pass/stripe-subscription-status';
import type { DrizzleTransaction, db as defaultDb } from '@/lib/drizzle';
import {
  KILO_PASS_MANAGE_CTA_LABEL,
  mapKiloPassStatusToClass,
  resolvePurchasePresentation,
  type KiloPassSubscriptionStatus,
  type PurchaseCtaAction,
  type PurchasePresentationKind,
  type PurchasePresentationReason,
  type PurchasePlatform,
  type PurchaseProduct,
  type PurchaseStatusClass,
  type PurchaseStorefront,
} from '@kilocode/app-shared/commerce';

type Db = typeof defaultDb;
type DbOrTx = Db | DrizzleTransaction;

export type PurchasePresentationResult = {
  kind: PurchasePresentationKind;
  statusClass: PurchaseStatusClass;
  reason: PurchasePresentationReason;
  cta: { label: string | null; action: PurchaseCtaAction };
  /** Absolute `https://` URL the CTA opens, or null when there is no web target. */
  webUrl: string | null;
  program: string | null;
};

export type PurchasePresentationInput = {
  platform: PurchasePlatform | null | undefined;
  storefront: PurchaseStorefront | null | undefined;
  product: PurchaseProduct;
  program?: string | null;
};

type SubscriptionForPresentation = {
  paymentProvider: KiloPassPaymentProvider;
  status: KiloPassSubscriptionStatus;
};

/**
 * Build the full purchase presentation from a subscription state and input.
 *
 * Pure: no I/O. Derives `statusClass` from the subscription status, sets
 * `hasStripeManagedPass` for a live Stripe sub, then resolves the presentation
 * kind through the shared helper.
 */
export function buildPurchasePresentation(params: {
  subscription: SubscriptionForPresentation | null;
  input: PurchasePresentationInput;
}): PurchasePresentationResult {
  const { subscription, input } = params;

  const hasStripeManagedPass =
    subscription != null &&
    subscription.paymentProvider === KiloPassPaymentProvider.Stripe &&
    !isStripeSubscriptionEnded(subscription.status);

  const statusClass = subscription
    ? mapKiloPassStatusToClass(subscription.status, { hasSubscription: true })
    : 'inactive';

  const presentation = resolvePurchasePresentation({
    platform: input.platform,
    storefront: input.storefront,
    product: input.product,
    program: input.program,
    hasStripeManagedPass,
  });

  const cta =
    presentation.cta.action === 'open_web'
      ? { label: KILO_PASS_MANAGE_CTA_LABEL, action: 'open_web' as const }
      : { label: null, action: presentation.cta.action };

  const webUrl =
    presentation.cta.action === 'open_web' && presentation.cta.webPath
      ? `${APP_URL}${presentation.cta.webPath}`
      : null;

  return {
    kind: presentation.kind,
    statusClass,
    reason: presentation.reason,
    cta,
    webUrl,
    program: presentation.program,
  };
}

/** Load the user's Kilo Pass state and build the purchase presentation. */
export async function getPurchasePresentationForUser(
  db: DbOrTx,
  kiloUserId: string,
  input: PurchasePresentationInput
): Promise<PurchasePresentationResult> {
  const subscription = await getKiloPassStateForUser(db, kiloUserId);
  return buildPurchasePresentation({ subscription, input });
}
