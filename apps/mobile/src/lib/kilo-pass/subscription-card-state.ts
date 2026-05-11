type KiloPassSubscriptionCardSubscription = {
  cancelAtPeriodEnd: boolean;
  currentPeriodBaseCreditsUsd: number;
  paymentProvider: 'stripe' | 'app_store' | 'google_play';
  refillAt: string | null;
  status: string;
};

export type KiloPassSubscriptionCardState = {
  action: 'none' | 'open-store-management' | 'open-store-sheet' | 'open-web-management';
  actionLabel: string | null;
  description: string;
  title: string;
};

type KiloPassSubscriptionCardOptions = {
  appStoreOwnership?: 'checking' | 'current-account' | 'another-account' | 'none';
};

export function shouldRenderKiloPassSubscriptionCard(params: {
  action: KiloPassSubscriptionCardState['action'];
  platformOS: string;
}): boolean {
  return params.platformOS === 'ios' || params.action === 'open-web-management';
}

function formatSubscriptionEndDate(iso: string | null): string {
  if (!iso) {
    return 'period end';
  }

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return 'period end';
  }

  return date.toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function isEndedSubscriptionStatus(status: string): boolean {
  return status === 'canceled' || status === 'incomplete_expired';
}

export function getKiloPassSubscriptionCardState(
  subscription: KiloPassSubscriptionCardSubscription | null | undefined,
  options: KiloPassSubscriptionCardOptions = {}
): KiloPassSubscriptionCardState {
  if (!subscription || isEndedSubscriptionStatus(subscription.status)) {
    if (options.appStoreOwnership === 'checking') {
      return {
        action: 'none',
        actionLabel: null,
        description: 'Checking App Store subscription',
        title: 'Kilo Pass',
      };
    }

    if (options.appStoreOwnership === 'another-account') {
      return {
        action: 'none',
        actionLabel: null,
        description: 'Kilo Pass subscription is owned by another account',
        title: 'Kilo Pass',
      };
    }

    if (options.appStoreOwnership === 'current-account') {
      return {
        action: 'none',
        actionLabel: null,
        description: 'Restoring App Store subscription',
        title: 'Kilo Pass',
      };
    }

    return {
      action: 'open-store-sheet',
      actionLabel: 'Subscribe',
      description: 'Monthly credits with bonus progress',
      title: 'Kilo Pass',
    };
  }

  const credits = `$${subscription.currentPeriodBaseCreditsUsd.toFixed(0)} monthly credits`;
  if (subscription.cancelAtPeriodEnd) {
    return {
      action:
        subscription.paymentProvider === 'stripe' ? 'open-web-management' : 'open-store-management',
      actionLabel: 'Manage',
      description: `${credits} · Ends ${formatSubscriptionEndDate(subscription.refillAt)}`,
      title: 'Kilo Pass canceling',
    };
  }

  if (subscription.paymentProvider === 'app_store') {
    return {
      action: 'open-store-management',
      actionLabel: 'Manage',
      description: `${credits} · Managed in App Store`,
      title: 'Kilo Pass active',
    };
  }

  if (subscription.paymentProvider === 'stripe') {
    return {
      action: 'open-web-management',
      actionLabel: 'Manage',
      description: `${credits} · Managed on web`,
      title: 'Kilo Pass active',
    };
  }

  return {
    action: 'open-store-sheet',
    actionLabel: 'Manage',
    description: credits,
    title: 'Kilo Pass active',
  };
}
