/**
 * Pure, platform-agnostic purchase presentation and status helpers.
 *
 * Shared by the web and mobile apps so both import one source of truth for
 * which purchase UI a platform, storefront, and product may show. This module
 * performs no I/O and imports no server or mobile code.
 */

export const PURCHASE_PLATFORMS = ['ios', 'android'] as const;
export type PurchasePlatform = (typeof PURCHASE_PLATFORMS)[number];

export const PURCHASE_STOREFRONTS = ['app_store', 'play', 'web'] as const;
export type PurchaseStorefront = (typeof PURCHASE_STOREFRONTS)[number];

export const PURCHASE_PRODUCTS = ['kilo_pass', 'credits'] as const;
export type PurchaseProduct = (typeof PURCHASE_PRODUCTS)[number];

export const PURCHASE_PRESENTATION_KINDS = ['native_iap', 'web_management', 'unavailable'] as const;
export type PurchasePresentationKind = (typeof PURCHASE_PRESENTATION_KINDS)[number];

export const PURCHASE_STATUS_CLASSES = [
  'healthy',
  'pending',
  'retryable',
  'terminal',
  'inactive',
] as const;
export type PurchaseStatusClass = (typeof PURCHASE_STATUS_CLASSES)[number];

/** Stripe subscription statuses a Kilo Pass row can hold. */
export type KiloPassSubscriptionStatus =
  | 'active'
  | 'incomplete'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'incomplete_expired'
  | 'unpaid'
  | 'paused';

export type PurchaseCtaAction = 'none' | 'open_web' | 'open_native';

export type PurchasePresentationCta = {
  action: PurchaseCtaAction;
  /** Relative web path the CTA opens, or null when there is no web target. */
  webPath: string | null;
};

export type PurchasePresentationReason =
  | 'credits_not_sold_on_ios'
  | 'kilo_pass_not_available_on_android'
  | 'unsupported_combination'
  | null;

export type PurchasePresentation = {
  kind: PurchasePresentationKind;
  reason: PurchasePresentationReason;
  cta: PurchasePresentationCta;
  /** Echoed from the input. Does not change the presentation kind. */
  program: string | null;
};

export type ResolvePurchasePresentationInput = {
  platform: PurchasePlatform | null | undefined;
  storefront: PurchaseStorefront | null | undefined;
  product: PurchaseProduct;
  program?: string | null;
  /**
   * True only when the payment provider is Stripe and the subscription is not
   * ended. `unpaid` is ended, so it is false.
   */
  hasStripeManagedPass: boolean;
};

const NO_CTA: PurchasePresentationCta = { action: 'none', webPath: null };

function webCta(webPath: string): PurchasePresentationCta {
  return { action: 'open_web', webPath };
}

/**
 * Resolve which purchase UI a platform, storefront, and product may show.
 *
 * Pure: no I/O, no imports of server or mobile code. `program` is echoed and
 * never changes the kind.
 */
export function resolvePurchasePresentation(
  input: ResolvePurchasePresentationInput
): PurchasePresentation {
  const { platform, storefront, product, hasStripeManagedPass } = input;
  const program = input.program ?? null;

  // Credits are not sold in the iOS app.
  if (product === 'credits' && platform === 'ios') {
    return { kind: 'unavailable', reason: 'credits_not_sold_on_ios', cta: NO_CTA, program };
  }

  // Credits on Android are managed on the web.
  if (product === 'credits' && platform === 'android') {
    return { kind: 'web_management', reason: null, cta: webCta('/credits'), program };
  }

  // Kilo Pass native IAP is allowed only for iOS App Store.
  if (product === 'kilo_pass' && platform === 'ios' && storefront === 'app_store') {
    return { kind: 'native_iap', reason: null, cta: NO_CTA, program };
  }

  // Android Kilo Pass is never native IAP.
  if (product === 'kilo_pass' && platform === 'android') {
    if (hasStripeManagedPass) {
      return {
        kind: 'web_management',
        reason: null,
        cta: webCta('/subscriptions/kilo-pass'),
        program,
      };
    }
    return {
      kind: 'unavailable',
      reason: 'kilo_pass_not_available_on_android',
      cta: NO_CTA,
      program,
    };
  }

  // Any other combo, including a missing platform, is unavailable.
  return { kind: 'unavailable', reason: 'unsupported_combination', cta: NO_CTA, program };
}

/**
 * Map a Kilo Pass subscription status (plus whether a subscription exists) to
 * a presentation status class.
 */
export function mapKiloPassStatusToClass(
  status: KiloPassSubscriptionStatus,
  options: { hasSubscription: boolean }
): PurchaseStatusClass {
  if (!options.hasSubscription) return 'inactive';

  switch (status) {
    case 'active':
      return 'healthy';
    case 'incomplete':
    case 'trialing':
      return 'pending';
    case 'past_due':
      return 'retryable';
    case 'canceled':
    case 'incomplete_expired':
    case 'unpaid':
      return 'terminal';
    case 'paused':
      return 'inactive';
    default:
      return 'inactive';
  }
}

/**
 * True only for iOS App Store Kilo Pass, the single native IAP combination.
 */
export function isNativeIapMutationAllowed(input: {
  platform: PurchasePlatform | null | undefined;
  storefront: PurchaseStorefront | null | undefined;
  product: PurchaseProduct;
}): boolean {
  return (
    input.platform === 'ios' && input.storefront === 'app_store' && input.product === 'kilo_pass'
  );
}
