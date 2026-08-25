import {
  KILO_PASS_TITLE,
  type PurchasePresentationKind,
  type PurchaseStatusClass,
} from '@kilocode/app-shared/commerce';
import { i18n } from '@/i18n';
import { formatDate, formatUsd } from '@/lib/format';
import { getResolvedLanguage } from '@/lib/hooks/use-language-preference';
import { parseTimestamp } from '@/lib/utils';

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
      actionLabel: string;
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
    accessibilityHint = i18n.t('kiloPass.opensManagementOnWeb');
  } else if (cardState.action === 'open-store-management') {
    accessibilityHint = i18n.t('kiloPass.opensAppStoreManagement');
  } else if (cardState.action === 'open-native') {
    accessibilityHint = i18n.t('kiloPass.opensPlans');
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
  // StoreKit returns `Transaction.appAccountToken` as an uppercase `UUID.uuidString`,
  // while the backend stores the lowercase Postgres uuid. Compare case-insensitively
  // or every restore on a device that already owns the pass reads as another owner.
  const currentAppAccountToken = params.currentAppAccountToken.toLowerCase();
  const hasDifferentOwnerPurchase = params.availablePurchases.some(
    purchase =>
      purchase.store === 'apple' &&
      purchase.purchaseState !== 'pending' &&
      enabledAppleProductIds.has(purchase.productId) &&
      Boolean(purchase.appAccountToken) &&
      purchase.appAccountToken?.toLowerCase() !== currentAppAccountToken
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
      actionLabel: i18n.t('common.retry'),
      description: i18n.t('kiloPass.tryAgainFromProfile'),
      kind: 'error',
      title: i18n.t('kiloPass.unavailable'),
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
        description: i18n.t('kiloPass.unavailableDescription'),
        title: KILO_PASS_TITLE,
      },
    };
  }

  if (presentation.kind === 'web_management') {
    return {
      kind: 'card',
      state: {
        action: 'open-web',
        actionLabel: i18n.t('kiloPass.manage'),
        description: i18n.t('kiloPass.webManagementDescription'),
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
        actionLabel: i18n.t('kiloPass.subscribe'),
        description: i18n.t('kiloPass.subscribeDescription'),
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
    return i18n.t('kiloPass.periodEnd');
  }

  const date = parseTimestamp(iso);
  if (Number.isNaN(date.getTime())) {
    return i18n.t('kiloPass.periodEnd');
  }

  return formatDate(date, getResolvedLanguage());
}

function getStatusClassTitle(statusClass: PurchaseStatusClass, cancelAtPeriodEnd: boolean): string {
  if (cancelAtPeriodEnd) {
    return i18n.t('kiloPass.statusCanceling');
  }
  if (statusClass === 'pending') {
    return i18n.t('kiloPass.statusPending');
  }
  if (statusClass === 'retryable') {
    return i18n.t('kiloPass.statusPastDue');
  }
  return i18n.t('kiloPass.statusActive');
}

function getActiveSubscriptionCardState(
  subscription: KiloPassSubscriptionCardSubscription,
  statusClass: PurchaseStatusClass
): KiloPassSubscriptionCardState {
  const credits = i18n.t('kiloPass.monthlyCredits', {
    credits: formatUsd(subscription.currentPeriodBaseCreditsUsd, i18n.language, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }),
  });
  const title = getStatusClassTitle(statusClass, subscription.cancelAtPeriodEnd);

  if (subscription.paymentProvider === 'google_play') {
    return {
      action: 'none',
      actionLabel: null,
      description: subscription.cancelAtPeriodEnd
        ? `${credits} · ${i18n.t('kiloPass.ends', {
            date: formatSubscriptionEndDate(subscription.refillAt),
          })} · ${i18n.t('kiloPass.managedOnGooglePlay')}`
        : `${credits} · ${i18n.t('kiloPass.managedOnGooglePlay')}`,
      title,
    };
  }

  if (subscription.paymentProvider === 'app_store') {
    return {
      action: 'open-store-management',
      actionLabel: i18n.t('kiloPass.manage'),
      description: subscription.cancelAtPeriodEnd
        ? `${credits} · ${i18n.t('kiloPass.ends', {
            date: formatSubscriptionEndDate(subscription.refillAt),
          })}`
        : `${credits} · ${i18n.t('kiloPass.managedInAppStore')}`,
      title,
    };
  }

  // Stripe-managed pass. On the native_iap surface this is inert (managed on web).
  return {
    action: 'none',
    actionLabel: null,
    description: subscription.cancelAtPeriodEnd
      ? `${credits} · ${i18n.t('kiloPass.ends', {
          date: formatSubscriptionEndDate(subscription.refillAt),
        })} · ${i18n.t('kiloPass.managedOnWeb')}`
      : `${credits} · ${i18n.t('kiloPass.managedOnWeb')}`,
    title,
  };
}
