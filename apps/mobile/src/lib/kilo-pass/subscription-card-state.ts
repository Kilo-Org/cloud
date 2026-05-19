import { parseTimestamp } from '@/lib/utils';

type KiloPassSubscriptionCardSubscription = {
  cancelAtPeriodEnd: boolean;
  currentPeriodBaseCreditsUsd: number;
  paymentProvider: 'stripe' | 'app_store' | 'google_play';
  refillAt: string | null;
  status: string;
};

type KiloPassSubscriptionCardState = {
  action: 'none' | 'open-store-management' | 'open-store-sheet' | 'open-web-management';
  actionLabel: string | null;
  description: string;
  title: string;
};

type KiloPassSubscriptionCardStateOptions = {
  platformOS?: string;
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
      kind: 'hidden' | 'loading';
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
  if (cardState.action === 'open-web-management') {
    accessibilityHint = 'Opens Kilo Pass management on web.';
  } else if (cardState.action === 'open-store-management') {
    accessibilityHint = 'Opens App Store subscription management.';
  } else if (cardState.action === 'open-store-sheet') {
    accessibilityHint = 'Opens Kilo Pass plans.';
  }

  return { accessibilityHint, accessibilityLabel };
}

export function shouldRenderKiloPassSubscriptionCard(params: {
  action: KiloPassSubscriptionCardState['action'];
  platformOS: string;
}): boolean {
  return (
    params.platformOS === 'ios' ||
    params.action === 'open-web-management' ||
    params.action === 'none'
  );
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

export function getKiloPassSubscriptionCardContentState(params: {
  appStoreOwnershipPreflight?: AppStoreKiloPassOwnershipPreflight;
  data: { subscription: KiloPassSubscriptionCardSubscription | null } | undefined;
  isError: boolean;
  isPending: boolean;
  platformOS: string;
}): KiloPassSubscriptionCardContentState {
  if (!params.data) {
    if (params.isError) {
      return {
        actionLabel: 'Retry',
        description: 'Try again from Profile.',
        kind: 'error',
        title: 'Kilo Pass unavailable',
      };
    }

    return { kind: 'loading' };
  }

  if (
    params.platformOS === 'ios' &&
    params.appStoreOwnershipPreflight === 'owned-by-another-account' &&
    (params.data.subscription === null ||
      isEndedSubscriptionStatus(params.data.subscription.status))
  ) {
    return {
      kind: 'card',
      state: {
        action: 'none',
        actionLabel: null,
        description: 'Kilo Pass subscription is owned by another account',
        title: 'Kilo Pass',
      },
    };
  }

  const state = getKiloPassSubscriptionCardState(params.data.subscription, {
    platformOS: params.platformOS,
  });
  if (
    !shouldRenderKiloPassSubscriptionCard({
      action: state.action,
      platformOS: params.platformOS,
    })
  ) {
    return { kind: 'hidden' };
  }

  return { kind: 'card', state };
}

function formatSubscriptionEndDate(iso: string | null): string {
  if (!iso) {
    return 'period end';
  }

  const date = parseTimestamp(iso);
  if (Number.isNaN(date.getTime())) {
    return 'period end';
  }

  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function isEndedSubscriptionStatus(status: string): boolean {
  return status === 'canceled' || status === 'incomplete_expired';
}

function getAppStoreSubscriptionCardState(params: {
  cancelAtPeriodEnd: boolean;
  credits: string;
  platformOS: string | undefined;
  refillAt: string | null;
}): KiloPassSubscriptionCardState {
  const title = params.cancelAtPeriodEnd ? 'Kilo Pass canceling' : 'Kilo Pass active';
  if (params.platformOS === 'android') {
    return {
      action: 'none',
      actionLabel: null,
      description: params.cancelAtPeriodEnd
        ? `${params.credits} · Ends ${formatSubscriptionEndDate(params.refillAt)} · Managed in App Store`
        : `${params.credits} · Managed in App Store`,
      title,
    };
  }

  return {
    action: 'open-store-management',
    actionLabel: 'Manage',
    description: params.cancelAtPeriodEnd
      ? `${params.credits} · Ends ${formatSubscriptionEndDate(params.refillAt)}`
      : `${params.credits} · Managed in App Store`,
    title,
  };
}

export function getKiloPassSubscriptionCardState(
  subscription: KiloPassSubscriptionCardSubscription | null | undefined,
  options: KiloPassSubscriptionCardStateOptions = {}
): KiloPassSubscriptionCardState {
  if (subscription === undefined) {
    throw new Error('Kilo Pass subscription card state requires resolved subscription data.');
  }

  if (subscription === null || isEndedSubscriptionStatus(subscription.status)) {
    return {
      action: 'open-store-sheet',
      actionLabel: 'Subscribe',
      description: 'Monthly credits with bonus progress',
      title: 'Kilo Pass',
    };
  }

  const credits = `$${subscription.currentPeriodBaseCreditsUsd.toFixed(0)} monthly credits`;
  if (subscription.paymentProvider === 'google_play') {
    return {
      action: 'none',
      actionLabel: null,
      description: subscription.cancelAtPeriodEnd
        ? `${credits} · Ends ${formatSubscriptionEndDate(subscription.refillAt)} · Managed on Google Play`
        : `${credits} · Managed on Google Play`,
      title: subscription.cancelAtPeriodEnd ? 'Kilo Pass canceling' : 'Kilo Pass active',
    };
  }

  if (subscription.paymentProvider === 'app_store') {
    return getAppStoreSubscriptionCardState({
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      credits,
      platformOS: options.platformOS,
      refillAt: subscription.refillAt,
    });
  }

  if (subscription.cancelAtPeriodEnd) {
    return {
      action: 'open-web-management',
      actionLabel: 'Manage',
      description: `${credits} · Ends ${formatSubscriptionEndDate(subscription.refillAt)}`,
      title: 'Kilo Pass canceling',
    };
  }

  return {
    action: 'open-web-management',
    actionLabel: 'Manage',
    description: `${credits} · Managed on web`,
    title: 'Kilo Pass active',
  };
}
