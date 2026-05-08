type KiloPassSubscriptionCardSubscription = {
  currentPeriodBaseCreditsUsd: number;
  paymentProvider: 'stripe' | 'app_store' | 'google_play';
};

type KiloPassSubscriptionCardState = {
  action: 'open-store-management' | 'open-store-sheet' | 'open-web-management';
  actionLabel: string;
  description: string;
  title: string;
};

export function getKiloPassSubscriptionCardState(
  subscription: KiloPassSubscriptionCardSubscription | null | undefined
): KiloPassSubscriptionCardState {
  if (!subscription) {
    return {
      action: 'open-store-sheet',
      actionLabel: 'Subscribe',
      description: 'Monthly credits with bonus progress',
      title: 'Kilo Pass',
    };
  }

  const credits = `$${subscription.currentPeriodBaseCreditsUsd.toFixed(0)} monthly credits`;
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
