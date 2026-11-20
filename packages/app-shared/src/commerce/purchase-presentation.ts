/**
 * Pure, platform-agnostic purchase presentation and status helpers.
 *
 * Shared by the web and mobile apps so both import one source of truth for the
 * purchase UI that a platform, a product and the Stripe-managed flag decide. The
 * module performs no I/O and imports no server or mobile code.
 */

/** Kilo Pass plan title. Consumed by mobile and E2E; keep exact. */
export const KILO_PASS_TITLE = 'Kilo Pass';

/** Label for the web-management CTA. Consumed by mobile and E2E; keep exact. */
export const KILO_PASS_MANAGE_CTA_LABEL = 'Manage';

export const PURCHASE_PLATFORMS = ['ios', 'android'] as const;
export type PurchasePlatform = (typeof PURCHASE_PLATFORMS)[number];

export const PURCHASE_STOREFRONTS = ['app_store', 'play', 'web'] as const;
export type PurchaseStorefront = (typeof PURCHASE_STOREFRONTS)[number];

export const PURCHASE_PRODUCTS = ['kilo_pass', 'credits'] as const;
export type PurchaseProduct = (typeof PURCHASE_PRODUCTS)[number];

export const PURCHASE_PRESENTATION_KINDS = ['web_management', 'unavailable'] as const;
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

/**
 * A CTA result is a pure value: a `none` CTA carries no web target, and an
 * `open_web` CTA always carries a relative web path.
 */
export type PurchasePresentationCta =
  | { readonly action: 'none'; readonly webPath: null }
  | { readonly action: 'open_web'; readonly webPath: string };

export type PurchaseCtaAction = PurchasePresentationCta['action'];

export type PurchasePresentationReason =
  | 'credits_not_sold_on_ios'
  | 'kilo_pass_not_sold_in_app'
  | 'unsupported_combination'
  | null;

export type PurchasePresentation =
  | {
      kind: 'web_management';
      reason: null;
      readonly cta: PurchasePresentationCta;
      program: string | null;
    }
  | {
      kind: 'unavailable';
      reason: Exclude<PurchasePresentationReason, null>;
      readonly cta: PurchasePresentationCta;
      program: string | null;
    };

export type ResolvePurchasePresentationInput = {
  platform: PurchasePlatform | null | undefined;
  /** Carried for callers; does not affect the resolved outcome today. */
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

function unavailable(
  reason: Exclude<PurchasePresentationReason, null>,
  program: string | null
): PurchasePresentation {
  return { kind: 'unavailable', reason, cta: NO_CTA, program };
}

/**
 * Resolve which purchase UI a platform, product, and the Stripe-managed flag may show.
 *
 * Pure: no I/O, no imports of server or mobile code. `program` is echoed and
 * never changes the kind.
 */
export function resolvePurchasePresentation(
  input: ResolvePurchasePresentationInput
): PurchasePresentation {
  const { platform, product, hasStripeManagedPass } = input;
  const program = input.program ?? null;

  // Credits are not sold in the iOS app.
  if (product === 'credits' && platform === 'ios') {
    return unavailable('credits_not_sold_on_ios', program);
  }

  // Credits on Android are managed on the web.
  if (product === 'credits' && platform === 'android') {
    return { kind: 'web_management', reason: null, cta: webCta('/credits'), program };
  }

  // Kilo Pass is sold on the web only. An Android Stripe subscriber manages it on the web.
  // iOS gets no web link: App Review restricts links to purchases outside the app.
  if (product === 'kilo_pass' && platform === 'android' && hasStripeManagedPass) {
    return {
      kind: 'web_management',
      reason: null,
      cta: webCta('/subscriptions/kilo-pass'),
      program,
    };
  }

  if (product === 'kilo_pass' && (platform === 'ios' || platform === 'android')) {
    return unavailable('kilo_pass_not_sold_in_app', program);
  }

  // Any other combo, including a missing platform, is unavailable.
  return unavailable('unsupported_combination', program);
}

const KILO_PASS_STATUS_CLASSES = {
  active: 'healthy',
  incomplete: 'pending',
  trialing: 'pending',
  past_due: 'retryable',
  canceled: 'terminal',
  incomplete_expired: 'terminal',
  unpaid: 'terminal',
  paused: 'inactive',
} satisfies Record<KiloPassSubscriptionStatus, PurchaseStatusClass>;

function isKiloPassSubscriptionStatus(status: string): status is KiloPassSubscriptionStatus {
  // Object.hasOwn (not `in`) so inherited keys like 'constructor' fall
  // through to the inactive fallback instead of leaking prototype members.
  return Object.hasOwn(KILO_PASS_STATUS_CLASSES, status);
}

/**
 * Map a Kilo Pass subscription status (plus whether a subscription exists) to
 * a presentation status class. `status` accepts the provider's value as-is: the
 * listed statuses are the known ones and anything else presents as inactive.
 */
export function mapKiloPassStatusToClass(
  status: string,
  options: { hasSubscription: boolean }
): PurchaseStatusClass {
  if (!options.hasSubscription) return 'inactive';

  return isKiloPassSubscriptionStatus(status) ? KILO_PASS_STATUS_CLASSES[status] : 'inactive';
}
