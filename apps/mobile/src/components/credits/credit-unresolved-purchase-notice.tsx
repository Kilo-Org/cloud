import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/**
 * What the store still holds for the request this owner is blocking on.
 *
 * `unknown` is admission restored from disk whose store lookup has not
 * answered; `found` is a lookup that returned the transaction, which the
 * completion may still post; `not-found` is a lookup that returned nothing, so
 * only a later store delivery can settle the earlier charge; and
 * `terminal-refusal` is a transaction the store keeps queuing but the backend
 * will never credit. Only the last one is a dead end, and even it keeps the
 * barrier until the person consents to another purchase.
 */
export type CreditPurchaseResolution = 'unknown' | 'found' | 'not-found' | 'terminal-refusal';

const WARNING_KEYS = {
  unknown: 'credits.unresolvedPurchase',
  found: 'credits.unresolvedPurchaseFound',
  'not-found': 'credits.unresolvedPurchaseNotFound',
  'terminal-refusal': 'credits.unresolvedPurchaseRefused',
} as const satisfies Record<CreditPurchaseResolution, string>;

/** Every variant the notice can paint, in the order the reserve lays them out. */
export const CREDIT_PURCHASE_RESOLUTIONS = [
  'unknown',
  'found',
  'not-found',
  'terminal-refusal',
] as const satisfies readonly CreditPurchaseResolution[];

type CreditUnresolvedPurchaseNoticeProps = {
  /** What the store holds for the earlier request, which picks the copy. */
  resolution: CreditPurchaseResolution;
  /** The selected current catalog pack consent would name, or null without one. */
  packLabel: string | null;
  /** That pack's store price, or null while the store has not priced it. */
  priceLabel: string | null;
  /** A purchase is in flight or the store is disconnected, so no action may run. */
  actionsDisabled: boolean;
  /** The owner selected a priced pack as the consented retry target. */
  buyAgainAvailable: boolean;
  onReconcile: () => void;
  onBuyAgain: () => void;
};

type NoticeCopyProps = {
  warning: string;
  packLabel: string | null;
  priceLabel: string | null;
  actionsDisabled: boolean;
  showBuyAgain: boolean;
  /** Consent is the primary action, so the store query takes the outline. */
  buyAgainFirst: boolean;
  /** Announce the warning through the status channel (the live copy only). */
  announce: boolean;
  onReconcile: () => void;
  onBuyAgain: () => void;
};

/**
 * One earlier purchase may still complete, so a second charge needs the person's
 * explicit consent. The retry is a store query: it names no pack and needs no
 * price, because it never starts a purchase — a retired or unidentifiable
 * earlier SKU must still reach it.
 */
function NoticeCopy({
  warning,
  packLabel,
  priceLabel,
  actionsDisabled,
  showBuyAgain,
  buyAgainFirst,
  announce,
  onReconcile,
  onBuyAgain,
}: Readonly<NoticeCopyProps>) {
  const { t } = useTranslation();
  const packCopy = packLabel !== null && priceLabel !== null ? [packLabel, priceLabel] : [];
  const reconcile = (
    <Button
      key="reconcile"
      accessibilityLabel={[t('common.tryAgain'), ...packCopy].join(', ')}
      accessibilityState={{ disabled: actionsDisabled }}
      disabled={actionsDisabled}
      onPress={onReconcile}
      size="action"
      testID="credit-unresolved-try-again"
      variant={buyAgainFirst ? 'outline' : 'default'}
    >
      <Text>{t('common.tryAgain')}</Text>
    </Button>
  );
  const buyAgain = (
    <Button
      key="buy-again"
      accessibilityLabel={[t('credits.buyAgain'), ...packCopy].join(', ')}
      accessibilityState={{ disabled: actionsDisabled }}
      disabled={actionsDisabled}
      onPress={onBuyAgain}
      size="action"
      testID="credit-unresolved-buy-again"
      variant={buyAgainFirst ? 'default' : 'outline'}
    >
      <Text>{t('credits.buyAgain')}</Text>
    </Button>
  );
  return (
    <View className="gap-3">
      {announce ? (
        <AccessibleStatus className="text-sm" message={warning} tone="warn" />
      ) : (
        <Text className="text-sm text-warn">{warning}</Text>
      )}
      {packCopy.length > 0 && (
        <View className="gap-1">
          <Text className="font-semibold text-foreground">{packLabel}</Text>
          <Text className="text-sm text-muted-foreground">{priceLabel}</Text>
        </View>
      )}
      <View className="flex-row flex-wrap gap-3">
        {showBuyAgain ? (buyAgainFirst ? [buyAgain, reconcile] : [reconcile, buyAgain]) : reconcile}
      </View>
    </View>
  );
}

/**
 * The notice for a purchase the store has not settled.
 *
 * The card's height is fixed by a reserved copy of every resolution variant,
 * painted over by the live one. The reserve is what a reader never sees: it
 * keeps the card's final size from the first frame, so the retry, the consent
 * target and the store's answer add no space and move nothing else on screen.
 */
export function CreditUnresolvedPurchaseNotice({
  resolution,
  packLabel,
  priceLabel,
  actionsDisabled,
  buyAgainAvailable,
  onReconcile,
  onBuyAgain,
}: Readonly<CreditUnresolvedPurchaseNoticeProps>) {
  const { t } = useTranslation();
  // A lookup that found nothing to complete, or a transaction that can never
  // complete, leaves the second charge as the person's only way forward: consent
  // leads and the store query stays reachable as the secondary action.
  const buyAgainFirst = resolution === 'not-found' || resolution === 'terminal-refusal';
  return (
    <View
      className="rounded-xl border border-border bg-card p-5"
      testID="credit-unresolved-purchase"
    >
      <View testID="credit-unresolved-purchase-slot">
        <View
          accessibilityElementsHidden
          className="flex-row overflow-hidden opacity-0"
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          testID="credit-unresolved-purchase-reserve"
        >
          {CREDIT_PURCHASE_RESOLUTIONS.map(candidate => (
            <View key={candidate} className="w-full shrink-0">
              <NoticeCopy
                announce={false}
                actionsDisabled={actionsDisabled}
                buyAgainFirst={buyAgainFirst}
                onBuyAgain={onBuyAgain}
                onReconcile={onReconcile}
                packLabel={packLabel}
                priceLabel={priceLabel}
                showBuyAgain
                warning={t(WARNING_KEYS[candidate])}
              />
            </View>
          ))}
        </View>
        <View className="absolute inset-0" testID="credit-unresolved-purchase-live">
          <NoticeCopy
            announce
            actionsDisabled={actionsDisabled}
            buyAgainFirst={buyAgainFirst}
            onBuyAgain={onBuyAgain}
            onReconcile={onReconcile}
            packLabel={packLabel}
            priceLabel={priceLabel}
            showBuyAgain={buyAgainAvailable}
            warning={t(WARNING_KEYS[resolution])}
          />
        </View>
      </View>
    </View>
  );
}
