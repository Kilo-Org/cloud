/* eslint-disable max-lines -- The Buy credits screen composes the store banner, loading, empty, error, and pack-row surfaces; each is a small rendered surface that mirrors the shared header/scroll pattern. */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { selectionHaptic } from '@/lib/haptics';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { ScreenHeader } from '@/components/screen-header';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { LEGAL_LINK_BOX_CLASS, LEGAL_LINK_ROW_CLASS } from '@/lib/a11y/tap-target';
import { isolateLtrBidiText } from '@/lib/bidi';
import { WEB_BASE_URL } from '@/lib/config';
import { getStoreUnavailableCopyKeys } from '@/lib/credits/store-products-loader';
import {
  getStoreCreditExpiryMessageKey,
  type StoreCreditProduct,
} from '@/lib/credits/store-products';
import { useStoreCreditProducts } from '@/lib/credits/use-store-credit-products';
import { getCreditStorefront } from '@/lib/credits/storefront';
import { useInlinePurchaseErrorOwnership } from '@/lib/credits/use-store-credit-purchase';
import { openExternalUrl } from '@/lib/external-link';
import { formatPrefixedMoney } from '@/lib/format';
import { useHideBalancePreference } from '@/lib/hooks/use-hide-balance-preference';
import { getStoreLegalLinks } from '@/lib/iap/legal-links';
import { SETTLE_WHILE_OFFLINE } from '@/lib/query/settle-while-offline';
import { useSideInsetStyle } from '@/lib/screen-insets';
import { HIDDEN_BALANCE } from '@/lib/storage-keys';
import { useTRPC } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { useCreditNativeIap } from './credit-native-iap-owner';
import { CreditExpiryNote } from './credit-expiry-note';

/** Reserved pack-row space while the store connects, so rows never jump in. */
const PACK_SKELETON_ROWS = 4;

/**
 * One-off credit packs bought with the store's own purchase sheet.
 *
 * The stores sell fixed SKUs, not an arbitrary amount, so the catalog is the
 * four preset amounts. Every row renders the backend amount; the store's
 * localized price appears when the store priced that pack, and a row the store
 * cannot price is disabled (its purchase would be unbillable).
 */
export function CreditPurchaseScreen() {
  const { t, i18n } = useTranslation();
  const { bottom: bottomInset } = useSafeAreaInsets();
  const sideInsetStyle = useSideInsetStyle();
  const storefront = getCreditStorefront();
  const trpc = useTRPC();
  const {
    connected,
    fetchStoreProducts,
    purchase,
    reconnectStore,
    completingProductId,
    errorMessageKey: purchaseErrorMessageKey,
    completedPurchaseCount,
    clearError,
  } = useCreditNativeIap();
  const {
    products,
    isLoading,
    isRefetching,
    storeUnavailable,
    catalogEmpty,
    errorMessageKey: productsErrorMessageKey,
    refetch,
    identityUnavailable,
    isRetryingIdentity,
    retryIdentity,
  } = useStoreCreditProducts({ connected, fetchStoreProducts, reconnectStore });
  // The screen renders purchase errors inline, so they must not also toast.
  useInlinePurchaseErrorOwnership();

  const balanceQuery = useQuery({
    ...trpc.user.getContextBalance.queryOptions({}),
    placeholderData: keepPreviousData,
    // The card holds a slot for each of these reads, so each must answer or
    // fail: a paused read on the default network mode would leave a skeleton in
    // place for as long as the device reports itself offline.
    ...SETTLE_WHILE_OFFLINE,
  });
  const refetchBalance = balanceQuery.refetch;
  const creditBlocksQuery = useQuery({
    ...trpc.user.getCreditBlocks.queryOptions({}),
    ...SETTLE_WHILE_OFFLINE,
  });

  // The amount here is the same one the Profile credits card masks, so the
  // same preference rules this screen. Until the disk read settles the choice
  // is unknown and the amounts stay masked.
  const { hideBalance, hasLoaded: hideBalanceLoaded } = useHideBalancePreference();
  const hideBalanceAmount = hideBalance || !hideBalanceLoaded;

  const [privacyPolicyLink, termsOfUseLink] = getStoreLegalLinks(WEB_BASE_URL);

  // A granted purchase bumps the owner's counter; a cancelled one releases the
  // request with no error key, so the counter is the only success signal.
  const completedPurchaseCountRef = useRef(completedPurchaseCount);
  useEffect(() => {
    if (completedPurchaseCount <= completedPurchaseCountRef.current) {
      return;
    }
    completedPurchaseCountRef.current = completedPurchaseCount;
    toast.success(t('credits.purchased'));
    void refetchBalance();
  }, [completedPurchaseCount, refetchBalance, t]);

  const purchasing = completingProductId !== null;
  // Only a catalog the backend answered as empty is the empty state: a store
  // query that is pending, paused or failed must not hide the packs the backend
  // catalog named.
  const packsEmpty = !isLoading && catalogEmpty;
  const balancePending = balanceQuery.isPending;
  const balanceFailed = balanceQuery.isError;
  // The card's title and its default body come from one per-store source, so
  // an iOS build can never name Google Play (or the reverse) for only one of
  // the two lines.
  const storeUnavailableCopy = getStoreUnavailableCopyKeys(storefront);
  const storeBannerBodyKey = productsErrorMessageKey ?? storeUnavailableCopy.bodyKey;

  const handlePackPress = (pack: StoreCreditProduct) => {
    selectionHaptic();
    clearError();
    void purchase(pack);
  };

  const renderBalanceValue = () => {
    if (balancePending) {
      return <Skeleton className="h-7 w-24 rounded" />;
    }
    if (balanceFailed) {
      return (
        <Pressable
          accessibilityLabel={t('profile.failedToLoadBalance')}
          accessibilityRole="button"
          className="min-h-11 justify-center active:opacity-70"
          onPress={() => {
            void refetchBalance();
          }}
        >
          <Text className="text-sm text-destructive">{t('profile.failedToLoadBalance')}</Text>
        </Pressable>
      );
    }
    // Always pass the label: a node React Native stops handing a label keeps
    // its previous native value on Android, so a masked amount that reveals
    // itself would still announce "Balance hidden" (the credits card's note).
    // The balance reads in the shape the Profile credits card paints it: the
    // symbol in front, the locale's digits, and its own left-to-right order —
    // its symbol is neutral to the paragraph's direction.
    const balanceAmount = formatPrefixedMoney(balanceQuery.data.balance, i18n.language);
    return (
      <Text
        className="text-2xl font-bold tabular-nums"
        accessibilityLabel={hideBalanceAmount ? t('profile.balanceHidden') : balanceAmount}
      >
        {hideBalanceAmount ? HIDDEN_BALANCE : isolateLtrBidiText(balanceAmount)}
      </Text>
    );
  };

  const renderExpirySlot = () => {
    // A failed read is not "no expiring credits": the slot states that the
    // expiry is unknown, using the same copy the Profile credits card shows,
    // and keeps its reserved height either way.
    if (creditBlocksQuery.isError) {
      return (
        <Text className="text-xs text-muted-foreground">{t('credits.expiryUnavailable')}</Text>
      );
    }
    if (creditBlocksQuery.isPending) {
      return <Skeleton className="h-3 w-40 max-w-full rounded" />;
    }
    return (
      <CreditExpiryNote
        creditBlocks={creditBlocksQuery.data.creditBlocks}
        hiddenAmount={hideBalanceAmount ? HIDDEN_BALANCE : undefined}
        emptyMessage={t('credits.noExpiringCredits')}
      />
    );
  };

  return (
    <View className="flex-1 bg-background" testID="credit-purchase-screen">
      <ScreenHeader title={t('credits.title')} modal />
      <View className="flex-1 px-5">
        <DetailScreenScrollView
          className="-mx-1 flex-1"
          contentContainerClassName="gap-3 px-1"
          showsVerticalScrollIndicator={false}
          // The footer below the scroller carries the safe-area inset, so the
          // scroller's own clearance would only add blank space above the
          // divider when the pack rows are scrolled to their end.
          bottomClearance={0}
        >
          {/* The card holds both of its data slots in every state: the amount (a
              skeleton, the value, or the failed read's own retry target) and
              the expiry caption, which is two lines at text-xs in this card's
              width and keeps one line when the account has none. It is the one
              block above the pack rows whose height comes from late data, so
              without the slots a settling read would move every row below it. */}
          <View className="rounded-xl border border-border bg-card px-5 py-4">
            <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
              {t('profile.credits')}
            </Text>
            <View className="mt-1 min-h-11 justify-center">{renderBalanceValue()}</View>
            <View className="mt-1 min-h-8 justify-center">{renderExpirySlot()}</View>
          </View>

          {/* The purchase error is rendered inline (the store sheet has just
              dismissed), so no toast accompanies it. AccessibleStatus is the
              one announcement channel that survives that: a polite live
              region on Android and an imperative announcement on iOS. A plain
              Text left a screen-reader user with no failure feedback at all. */}
          <AccessibleStatus
            message={purchaseErrorMessageKey ? t(purchaseErrorMessageKey) : null}
            className="px-1 text-sm"
          />

          {/* The identity read gates both catalog reads, so its failure is the
              one state where nothing else can settle. It gets the same card
              shape as the store's failure, with its own retry: an empty pack
              area would read as "nothing for sale" and offer no way back. */}
          {identityUnavailable && (
            <View className="gap-3 rounded-xl border border-border bg-card p-5">
              <Text className="font-semibold text-foreground">{t('queryError.serverTitle')}</Text>
              <Text className="text-sm text-muted-foreground">
                {t('organization.boundary.loadErrorMessage')}
              </Text>
              <Button
                accessibilityLabel={t('common.tryAgain')}
                accessibilityState={{ busy: isRetryingIdentity, disabled: isRetryingIdentity }}
                className="self-start"
                disabled={isRetryingIdentity}
                onPress={() => {
                  void retryIdentity();
                }}
                variant="outline"
              >
                <Text>{t('common.tryAgain')}</Text>
              </Button>
            </View>
          )}

          {storeUnavailable && (
            <View className="gap-3 rounded-xl border border-border bg-card p-5">
              <Text className="font-semibold text-foreground">
                {t(storeUnavailableCopy.titleKey)}
              </Text>
              <Text className="text-sm text-muted-foreground">{t(storeBannerBodyKey)}</Text>
              <Button
                accessibilityLabel={t('common.tryAgain')}
                accessibilityState={{ busy: isRefetching, disabled: isRefetching }}
                className="self-start"
                disabled={isRefetching}
                onPress={() => {
                  void refetch();
                }}
                variant="outline"
              >
                <Text>{t('common.tryAgain')}</Text>
              </Button>
            </View>
          )}

          {packsEmpty && (
            <View className="rounded-xl border border-border bg-card p-5">
              <Text className="text-sm text-muted-foreground">{t('credits.empty')}</Text>
            </View>
          )}

          {isLoading &&
            Array.from({ length: PACK_SKELETON_ROWS }, (_, index) => (
              <View key={index} className="rounded-xl border border-border bg-card p-5">
                <View className="flex-row items-start justify-between gap-4">
                  <Skeleton className="h-6 flex-1 rounded" />
                  <Skeleton className="h-6 w-16 rounded" />
                </View>
                <Skeleton className="mt-2 h-8 w-full rounded" />
              </View>
            ))}

          {!isLoading &&
            products.map(pack => {
              // The pack names a credit amount in the same shape as the balance
              // above it. The store's own localized price stays as the store
              // wrote it.
              const packLabel = t('credits.packLabel', {
                amount: isolateLtrBidiText(
                  formatPrefixedMoney(pack.backend.amountUsd, i18n.language)
                ),
              });
              const expiryMessageKey = getStoreCreditExpiryMessageKey(pack.backend, storefront);
              const expiryMessage = expiryMessageKey ? t(expiryMessageKey) : undefined;
              const hasStorePrice = pack.storeProductId !== null && pack.displayPrice !== null;
              const rowCompleting =
                completingProductId !== null && completingProductId === pack.storeProductId;
              // A disconnected owner has no purchase-update listeners (expo-iap
              // drops them when initialization fails), so even a priced row
              // cannot complete: keep every row disabled until it reconnects.
              const disabled = purchasing || !connected || !hasStorePrice;
              const priceLabel = rowCompleting
                ? t('kiloPass.completingPurchase')
                : (pack.displayPrice ?? t('credits.priceUnavailable'));
              // The row is one accessible element: the explicit label replaces
              // its children, so the charge and the disabled reason must be in
              // the label itself (the canonical Kilo Pass row does the same).
              const rowAccessibilityLabel = [packLabel, priceLabel, expiryMessage]
                .filter(Boolean)
                .join(', ');

              return (
                <Pressable
                  key={pack.backend.appleProductId}
                  accessibilityLabel={rowAccessibilityLabel}
                  accessibilityRole="button"
                  accessibilityState={{ busy: rowCompleting, disabled }}
                  className={cn(
                    'rounded-xl border border-border bg-card p-5 active:opacity-80',
                    disabled && 'opacity-50'
                  )}
                  disabled={disabled}
                  onPress={() => {
                    handlePackPress(pack);
                  }}
                >
                  <View className="flex-row items-start justify-between gap-4">
                    <Text className="flex-1 font-semibold text-foreground">{packLabel}</Text>
                    <Text className="text-base font-semibold text-foreground tabular-nums">
                      {priceLabel}
                    </Text>
                  </View>
                  {expiryMessage && (
                    <Text className="mt-2 text-xs text-muted-foreground">{expiryMessage}</Text>
                  )}
                </Pressable>
              );
            })}
        </DetailScreenScrollView>
      </View>
      {/* The description and the store's legal links are the screen's footer,
          outside the scroll view. The pack area's height comes from the store —
          placeholder rows while it connects, the priced rows after, an empty
          card or the unavailable card instead — so copy written under it inside
          the scroll is pushed by every one of those swaps. Pinned below the
          scroll, the copy holds its place in every state and every locale.

          `pt-[17px]` is the gap the legal boxes already leave around their own
          ink: each box reserves a 48dp target around a 14dp line, so 17dp sits
          above and below the link text by construction. Matching that number
          above the description gives the footer one rhythm — divider,
          description, links — with no margin pulled through a neighbouring
          frame, and the boxes keep their full audited height.

          The divider spans the whole width, so the content inside carries the
          side insets itself: the scroller above insets its own content for the
          landscape notch band, and copy outside it would otherwise sit nearer
          the edge than the rows it follows. */}
      <View className="border-t border-border" style={{ paddingBottom: Math.max(bottomInset, 16) }}>
        {/* The side inset and the gutter sit on separate wrappers: an inline
            padding value replaces a className's `px-5` on the same node, so one
            node holding both would lose the gutter wherever an inset is
            non-zero. */}
        <View style={sideInsetStyle}>
          <View className="px-5 pt-[17px]">
            <Text className="text-xs text-muted-foreground">{t('credits.description')}</Text>
            <View className={LEGAL_LINK_ROW_CLASS}>
              <Pressable
                accessibilityRole="link"
                className={cn(LEGAL_LINK_BOX_CLASS, 'active:opacity-70')}
                onPress={() => {
                  void openExternalUrl(termsOfUseLink.url, { label: termsOfUseLink.label });
                }}
              >
                <Text className="text-xs text-primary underline">{termsOfUseLink.label}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="link"
                className={cn(LEGAL_LINK_BOX_CLASS, 'active:opacity-70')}
                onPress={() => {
                  void openExternalUrl(privacyPolicyLink.url, { label: privacyPolicyLink.label });
                }}
              >
                <Text className="text-xs text-primary underline">{privacyPolicyLink.label}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}
