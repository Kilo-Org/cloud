import { parseTimestamp } from '@/lib/utils';

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

export type KiloPassSubscriptionCardAccessibility = {
  accessibilityHint: string | undefined;
  accessibilityLabel: string;
};

export function getKiloPassSubscriptionCardAccessibility(
  cardState: KiloPassSubscriptionCardState
): KiloPassSubscriptionCardAccessibility {
  const accessibilityLabel = [cardState.title, cardState.description, cardState.actionLabel]
    .filter(Boolean)
    .join('. ');
  const accessibilityHint =
    cardState.action === 'open-web-management'
      ? 'Opens Kilo Pass management on web.'
      : cardState.action === 'open-store-management'
        ? 'Opens App Store subscription management.'
        : cardState.action === 'open-store-sheet'
          ? 'Opens Kilo Pass plans.'
          : undefined;

  return { accessibilityHint, accessibilityLabel };
}

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
