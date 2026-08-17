import {
  KILO_PASS_MANAGE_CTA_LABEL,
  KILO_PASS_TITLE,
  KILO_PASS_UNAVAILABLE_DESCRIPTION,
  KILO_PASS_WEB_MANAGEMENT_DESCRIPTION,
  type PurchasePresentationKind,
  type PurchaseStatusClass,
} from '@kilocode/app-shared/commerce';
import { formatDate, parseTimestamp } from '@/lib/utils';

type KiloPassSubscriptionCardSubscription = {
  cancelAtPeriodEnd: boolean;
  currentPeriodBaseCreditsUsd: number;
  paymentProvider: 'stripe' | 'app_store' | 'google_play';
  refillAt: string | null;
  status: string;
};

type KiloPassSubscriptionCardAction = 'none' | 'open-web' | 'open-native' | 'open-store-management';

type KiloPassSubscriptionCardState = {
  action: KiloPassSubscriptionCardAction;
  actionLabel: string | null;
  description: string;
  title: string;
};

export type AppStoreKiloPassOwnershipPreflight = 'owned-by-another-account' | null;

type AppStoreKiloPassAvailablePurchase = {
  appAccountToken?: string | null;
  productId: string;
  purchaseState?: string | null;
  store?: string | null;
};

type KiloPassSubscriptionCardContentState =
  | {
      kind: 'card';
      state: KiloPassSubscriptionCardState;
    }
  | {
      actionLabel: 'Retry';
      description: string;
      kind: 'error';
      title: string;
    }
  | {
      kind: 'loading';
    };

type KiloPassSubscriptionCardAccessibility = {
  accessibilityHint: string | undefined;
  accessibilityLabel: string;
};

export function getKiloPassSubscriptionCardAccessibility(
  cardState: KiloPassSubscriptionCardState
): KiloPassSubscriptionCardAccessibility {
  const accessibilityLabel = [cardState.title, cardState.description, cardState.actionLabel]
    .filter(Boolean)
    .join('. ');
  let accessibilityHint: string | undefined = undefined;
  if (cardState.action === 'open-web') {
    accessibilityHint = 'Opens Kilo Pass management on web.';
  } else if (cardState.action === 'open-store-management') {
    accessibilityHint = 'Opens App Store subscription management.';
  } else if (cardState.action === 'open-native') {
    accessibilityHint = 'Opens Kilo Pass plans.';
  }

  return { accessibilityHint, accessibilityLabel };
}

export function getAppStoreKiloPassOwnershipPreflight(params: {
  availablePurchases: readonly AppStoreKiloPassAvailablePurchase[];
  currentAppAccountToken: string | null | undefined;
  enabledAppleProductIds: readonly string[];
  platformOS: string;
}): AppStoreKiloPassOwnershipPreflight {
  if (params.platformOS !== 'ios' || !params.currentAppAccountToken) {
    return null;
  }

  const enabledAppleProductIds = new Set(params.enabledAppleProductIds);
  const hasDifferentOwnerPurchase = params.availablePurchases.some(
    purchase =>
      purchase.store === 'apple' &&
      purchase.purchaseState !== 'pending' &&
      enabledAppleProductIds.has(purchase.productId) &&
      Boolean(purchase.appAccountToken) &&
      purchase.appAccountToken !== params.currentAppAccountToken
  );

  return hasDifferentOwnerPurchase ? 'owned-by-another-account' : null;
}

/**
 * Derive the profile card content from the server purchase presentation and
 * the current subscription state. The presentation kind decides the surface;
 * `statusClass` decides whether a subscription is labeled active.
 */
export function getKiloPassSubscriptionCardContentState(params: {
  presentation:
    | {
        kind: PurchasePresentationKind;
        statusClass: PurchaseStatusClass;
      }
    | undefined;
  presentationIsError: boolean;
  presentationIsPending: boolean;
  subscription: KiloPassSubscriptionCardSubscription | null | undefined;
  stateIsError: boolean;
  stateIsPending: boolean;
  platformOS: string;
}): KiloPassSubscriptionCardContentState {
  if (params.presentationIsPending || params.stateIsPending) {
    return { kind: 'loading' };
  }

  if (params.presentationIsError || params.stateIsError) {
    return {
      actionLabel: 'Retry',
      description: 'Try again from Profile.',
      kind: 'error',
      title: 'Kilo Pass unavailable',
    };
  }

  const presentation = params.presentation;
  if (!presentation) {
    return { kind: 'loading' };
  }

  if (presentation.kind === 'unavailable') {
    return {
      kind: 'card',
      state: {
        action: 'open-native',
        actionLabel: null,
        description: KILO_PASS_UNAVAILABLE_DESCRIPTION,
        title: KILO_PASS_TITLE,
      },
    };
  }

  if (presentation.kind === 'web_management') {
    return {
      kind: 'card',
      state: {
        action: 'open-web',
        actionLabel: KILO_PASS_MANAGE_CTA_LABEL,
        description: KILO_PASS_WEB_MANAGEMENT_DESCRIPTION,
        title: KILO_PASS_TITLE,
      },
    };
  }

  // native_iap
  const subscription = params.subscription;
  const hasLiveSubscription = subscription != null && isLiveStatusClass(presentation.statusClass);
  if (!hasLiveSubscription) {
    return {
      kind: 'card',
      state: {
        action: 'open-native',
        actionLabel: 'Subscribe',
        description: 'Monthly credits with bonus progress',
        title: KILO_PASS_TITLE,
      },
    };
  }

  return {
    kind: 'card',
    state: getActiveSubscriptionCardState(subscription, presentation.statusClass),
  };
}

function isLiveStatusClass(statusClass: PurchaseStatusClass): boolean {
  return statusClass === 'healthy' || statusClass === 'pending' || statusClass === 'retryable';
}

function formatSubscriptionEndDate(iso: string | null): string {
  if (!iso) {
    return 'period end';
  }

  const date = parseTimestamp(iso);
  if (Number.isNaN(date.getTime())) {
    return 'period end';
  }

  return formatDate(date);
}

function getStatusClassTitle(statusClass: PurchaseStatusClass, cancelAtPeriodEnd: boolean): string {
  if (cancelAtPeriodEnd) {
    return 'Kilo Pass canceling';
  }
  switch (statusClass) {
    case 'healthy': {
      return 'Kilo Pass active';
    }
    case 'pending': {
      return 'Kilo Pass pending';
    }
    case 'retryable': {
      return 'Kilo Pass past due';
    }
    case 'inactive': {
      return 'Kilo Pass active';
    }
    case 'terminal': {
      return 'Kilo Pass active';
    }
    default: {
      return 'Kilo Pass active';
    }
  }
}

function getActiveSubscriptionCardState(
  subscription: KiloPassSubscriptionCardSubscription,
  statusClass: PurchaseStatusClass
): KiloPassSubscriptionCardState {
  const credits = `$${subscription.currentPeriodBaseCreditsUsd.toFixed(0)} monthly credits`;
  const title = getStatusClassTitle(statusClass, subscription.cancelAtPeriodEnd);

  if (subscription.paymentProvider === 'google_play') {
    return {
      action: 'none',
      actionLabel: null,
      description: subscription.cancelAtPeriodEnd
        ? `${credits} · Ends ${formatSubscriptionEndDate(subscription.refillAt)} · Managed on Google Play`
        : `${credits} · Managed on Google Play`,
      title,
    };
  }

  if (subscription.paymentProvider === 'app_store') {
    return {
      action: 'open-store-management',
      actionLabel: 'Manage',
      description: subscription.cancelAtPeriodEnd
        ? `${credits} · Ends ${formatSubscriptionEndDate(subscription.refillAt)}`
        : `${credits} · Managed in App Store`,
      title,
    };
  }

  // Stripe-managed pass. On the native_iap surface this is inert (managed on web).
  return {
    action: 'none',
    actionLabel: null,
    description: subscription.cancelAtPeriodEnd
      ? `${credits} · Ends ${formatSubscriptionEndDate(subscription.refillAt)} · This Kilo Pass is managed on web`
      : `${credits} · This Kilo Pass is managed on web`,
    title,
  };
}
