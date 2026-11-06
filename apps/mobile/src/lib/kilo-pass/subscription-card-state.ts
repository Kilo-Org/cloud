import { KILO_PASS_TITLE, type PurchasePresentationKind } from '@kilocode/app-shared/commerce';
import { i18n } from '@/i18n';

type KiloPassSubscriptionCardState = {
  action: 'open-web' | 'open-native';
  actionLabel: string | null;
  description: string;
  title: string;
};

type KiloPassSubscriptionCardContentState =
  | { kind: 'card'; state: KiloPassSubscriptionCardState }
  | { kind: 'error'; actionLabel: string; description: string; title: string }
  | { kind: 'loading' };

/**
 * A card the reader cannot act on: purchase resolution answered but gives this
 * app nothing to buy or manage in it. `open-web` states keep their web CTA;
 * everything else renders inert and muted, so the dead end stops reading as a
 * disabled row. One marker for both platforms and every storefront.
 */
export const UNAVAILABLE_PASS_CARD: KiloPassSubscriptionCardContentState = {
  kind: 'card',
  state: {
    action: 'open-native',
    actionLabel: null,
    description: i18n.t('kiloPass.purchaseUnavailable'),
    title: KILO_PASS_TITLE,
  },
};

export function getKiloPassSubscriptionCardAccessibility(cardState: KiloPassSubscriptionCardState) {
  return {
    accessibilityHint:
      cardState.action === 'open-web' ? i18n.t('kiloPass.opensManagementOnWeb') : undefined,
    accessibilityLabel: [cardState.title, cardState.description, cardState.actionLabel]
      .filter(Boolean)
      .join('. '),
  };
}

/** Derive the profile card solely from the server purchase presentation. */
export function getKiloPassSubscriptionCardContentState(params: {
  presentation: { kind: PurchasePresentationKind } | undefined;
  presentationIsError: boolean;
  presentationIsPending: boolean;
}): KiloPassSubscriptionCardContentState {
  if (params.presentationIsPending) {
    return { kind: 'loading' };
  }
  if (params.presentationIsError) {
    return {
      actionLabel: i18n.t('common.retry'),
      description: i18n.t('kiloPass.tryAgainFromProfile'),
      kind: 'error',
      title: i18n.t('kiloPass.unavailable'),
    };
  }
  if (!params.presentation) {
    return { kind: 'loading' };
  }
  if (params.presentation.kind !== 'web_management') {
    return UNAVAILABLE_PASS_CARD;
  }
  return {
    kind: 'card',
    state: {
      action: 'open-web',
      actionLabel: i18n.t('kiloPass.manage'),
      description: i18n.t('kiloPass.managedOnWeb'),
      title: KILO_PASS_TITLE,
    },
  };
}
