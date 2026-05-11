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

function formatSubscriptionEndDate(iso: string | null): string {
  if (!iso) {
    return 'period end';
  }

  const date = parseTimestamp(iso);
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
  subscription: KiloPassSubscriptionCardSubscription | null | undefined
): KiloPassSubscriptionCardState {
  if (!subscription || isEndedSubscriptionStatus(subscription.status)) {
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

  return {
    action: 'open-web-management',
    actionLabel: 'Manage',
    description: `${credits} · Managed on web`,
    title: 'Kilo Pass active',
  };
}
