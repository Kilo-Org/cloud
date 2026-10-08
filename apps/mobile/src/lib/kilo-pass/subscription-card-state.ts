import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { KILO_PASS_TITLE } from '@kilocode/app-shared/commerce';
import { i18n } from '@/i18n';
import { formatDate, formatUsd } from '@/lib/format';
import { getResolvedLanguage } from '@/lib/hooks/use-language-preference';
import { parseTimestamp } from '@/lib/utils';

type RouterOutputs = inferRouterOutputs<MobileRouter>;
type SubscriptionState = NonNullable<RouterOutputs['kiloPass']['getState']['subscription']>;
export type KiloPassSubscription = Omit<SubscriptionState, 'paymentProvider' | 'cadence'> & {
  paymentProvider: `${SubscriptionState['paymentProvider']}`;
  cadence: `${SubscriptionState['cadence']}`;
};

export function isLiveKiloPassSubscription(subscription: KiloPassSubscription): boolean {
  return !['canceled', 'incomplete_expired'].includes(subscription.status);
}

export function getKiloPassStatusTitle(subscription: KiloPassSubscription): string {
  if (!isLiveKiloPassSubscription(subscription)) {
    return i18n.t('organization.kiloPass.ended');
  }
  if (subscription.status === 'paused') {
    return i18n.t('kiloPass.statusPaused');
  }
  if (subscription.status === 'incomplete') {
    return i18n.t('kiloPass.statusPending');
  }
  if (subscription.status === 'past_due' || subscription.status === 'unpaid') {
    return i18n.t('kiloPass.statusPastDue');
  }
  return i18n.t(
    subscription.cancelAtPeriodEnd ? 'kiloPass.statusCanceling' : 'kiloPass.statusActive'
  );
}

export function getKiloPassPaidThrough(subscription: KiloPassSubscription): string | null {
  // nextBillingAt is the paid store expiry; refillAt can be an earlier monthly
  // issuance date for a yearly Pass. A trial or unpaid period is not paid expiry.
  if (subscription.status !== 'active' || !subscription.nextBillingAt) {
    return null;
  }
  const date = parseTimestamp(subscription.nextBillingAt);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return i18n.t('kiloPass.paidThrough', { date: formatDate(date, getResolvedLanguage()) });
}

export function getKiloPassProviderDescription(subscription: KiloPassSubscription): string {
  if (subscription.paymentProvider === 'app_store') {
    return i18n.t('kiloPass.managedInAppStore');
  }
  if (subscription.paymentProvider === 'google_play') {
    return i18n.t('kiloPass.managedOnGooglePlay');
  }
  return i18n.t('kiloPass.managedOnWeb');
}

export function getKiloPassSubscriptionCardContentState(params: {
  subscription: KiloPassSubscription | null | undefined;
  stateIsError: boolean;
  stateIsPending: boolean;
}) {
  if (params.stateIsPending) {
    return { kind: 'loading' as const };
  }
  if (params.stateIsError) {
    return {
      kind: 'error' as const,
      actionLabel: i18n.t('common.retry'),
      description: i18n.t('kiloPass.tryAgainFromProfile'),
      title: i18n.t('kiloPass.unavailable'),
    };
  }
  const subscription = params.subscription;
  return {
    kind: 'card' as const,
    state: {
      action: 'open-native' as const,
      actionLabel: i18n.t('common.details'),
      title: subscription ? getKiloPassStatusTitle(subscription) : KILO_PASS_TITLE,
      description: subscription
        ? [
            i18n.t('kiloPass.monthlyCredits', {
              credits: formatUsd(subscription.currentPeriodBaseCreditsUsd, i18n.language, {
                minimumFractionDigits: 0,
                maximumFractionDigits: 0,
              }),
            }),
            getKiloPassPaidThrough(subscription),
            getKiloPassProviderDescription(subscription),
          ]
            .filter(Boolean)
            .join(' · ')
        : i18n.t('organization.kiloPass.notSubscribed'),
    },
  };
}

export function getKiloPassSubscriptionCardAccessibility(cardState: {
  title: string;
  description: string;
  actionLabel: string;
}) {
  return {
    accessibilityLabel: [cardState.title, cardState.description, cardState.actionLabel].join('. '),
  };
}
