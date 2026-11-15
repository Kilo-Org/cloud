import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

type CreditUnresolvedPurchaseNoticeProps = {
  /** The pack both actions name, or null while the catalog has not resolved it. */
  packLabel: string | null;
  /** That pack's store price, or the price-unavailable copy. */
  priceLabel: string | null;
  /** A purchase is in flight or the store is disconnected, so no action may run. */
  actionsDisabled: boolean;
  /** The owner reconciled empty and this pack is the consented retry target. */
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
  announce: boolean;
  onReconcile: () => void;
  onBuyAgain: () => void;
};

/**
 * One earlier purchase may still complete, so a second charge needs the person's
 * explicit consent. The retry is a store query: it can run whether or not the
 * pack is priced, because it never starts a purchase.
 */
function NoticeCopy({
  warning,
  packLabel,
  priceLabel,
  actionsDisabled,
  showBuyAgain,
  announce,
  onReconcile,
  onBuyAgain,
}: Readonly<NoticeCopyProps>) {
  const { t } = useTranslation();
  return (
    <View className="gap-3">
      {announce ? (
        <AccessibleStatus className="text-sm" message={warning} tone="warn" />
      ) : (
        <Text className="text-sm text-warn">{warning}</Text>
      )}
      {packLabel !== null && priceLabel !== null && (
        <View className="gap-1">
          <Text className="font-semibold text-foreground">{packLabel}</Text>
          <Text className="text-sm text-muted-foreground">{priceLabel}</Text>
        </View>
      )}
      {packLabel !== null && priceLabel !== null && (
        <View className="flex-row flex-wrap gap-3">
          <Button
            accessibilityLabel={[t('common.tryAgain'), packLabel, priceLabel].join(', ')}
            accessibilityState={{ disabled: actionsDisabled }}
            disabled={actionsDisabled}
            onPress={onReconcile}
            size="action"
            testID="credit-unresolved-try-again"
            variant="default"
          >
            <Text>{t('common.tryAgain')}</Text>
          </Button>
          {showBuyAgain && (
            <Button
              accessibilityLabel={[t('credits.buyAgain'), packLabel, priceLabel].join(', ')}
              accessibilityState={{ disabled: actionsDisabled }}
              disabled={actionsDisabled}
              onPress={onBuyAgain}
              size="action"
              testID="credit-unresolved-buy-again"
              variant="outline"
            >
              <Text>{t('credits.buyAgain')}</Text>
            </Button>
          )}
        </View>
      )}
    </View>
  );
}

/**
 * The notice for a purchase the store has not settled. The copy is laid out
 * once in the flow and kept from every reader, then painted over by the live
 * copy, so the card's height is final on the first frame and the retry adds no
 * space when the store reports nothing to complete.
 */
export function CreditUnresolvedPurchaseNotice({
  packLabel,
  priceLabel,
  actionsDisabled,
  buyAgainAvailable,
  onReconcile,
  onBuyAgain,
}: Readonly<CreditUnresolvedPurchaseNoticeProps>) {
  const { t } = useTranslation();
  const warning = t('credits.unresolvedPurchase');
  return (
    <View
      className="rounded-xl border border-border bg-card p-5"
      testID="credit-unresolved-purchase"
    >
      <View testID="credit-unresolved-purchase-slot">
        <View
          accessibilityElementsHidden
          className="opacity-0"
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          testID="credit-unresolved-purchase-reserve"
        >
          <NoticeCopy
            announce={false}
            actionsDisabled={actionsDisabled}
            onBuyAgain={onBuyAgain}
            onReconcile={onReconcile}
            packLabel={packLabel}
            priceLabel={priceLabel}
            showBuyAgain
            warning={warning}
          />
        </View>
        <View className="absolute inset-0" testID="credit-unresolved-purchase-live">
          <NoticeCopy
            announce
            actionsDisabled={actionsDisabled}
            onBuyAgain={onBuyAgain}
            onReconcile={onReconcile}
            packLabel={packLabel}
            priceLabel={priceLabel}
            showBuyAgain={buyAgainAvailable}
            warning={warning}
          />
        </View>
      </View>
    </View>
  );
}
