/* eslint-disable max-lines -- The Buy credits screen composes the store banner, loading, empty, error, and pack-row surfaces; each is a small rendered surface that mirrors the shared header/scroll pattern. */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { selectionHaptic } from '@/lib/haptics';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
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
import { useLiveFontScale } from '@/lib/font-scale/system-font-scale-context';
import { useHideBalancePreference } from '@/lib/hooks/use-hide-balance-preference';
import { getStoreLegalLinks } from '@/lib/iap/legal-links';
import { SETTLE_WHILE_OFFLINE } from '@/lib/query/settle-while-offline';
import { HIDDEN_BALANCE } from '@/lib/storage-keys';
import { useTRPC } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { useCreditNativeIap } from './credit-native-iap-owner';
import { CreditExpiryNote } from './credit-expiry-note';

/** Reserved pack-row space while the store connects, so rows never jump in. */
const PACK_SKELETON_ROWS = 4;

/**
 * The height the pack area holds in every state, at the default font scale.
 *
 * The tallest state carries every surface the area can show at once: the
 * inline purchase error, the store's notice, and one unpriced row per catalog
 * pack. All three are reachable together, because a purchase error survives
 * the store dropping — it is cleared only by a new purchase attempt or a
 * completed one — and the backend catalog still names the packs when the store
 * cannot price them.
 *
 * Every block's height is fixed at the default scale:
 *
 * - a row is 80 dp: its 20 dp paddings, one title line, an 8 dp gap and its
 *   12 dp expiry line. Its title is capped at one line, so a longer pack name
 *   cannot make a row taller;
 * - the notice is 180 dp with a three-line body: its 20 dp paddings, the title
 *   line, three body lines, the retry control, and the gaps between them. Its
 *   body is capped at three lines for the same reason;
 * - the purchase error is two capped lines of `text-sm`;
 * - the gap between siblings is the scroller's 10.5 dp step, and the column
 *   lays out one gap more than it has rows because the notice and the error
 *   are siblings too.
 *
 * The sum is 587.5 dp for the four packs the catalog sells.
 *
 * {@link packAreaMinHeight} multiplies the sum by the live font scale, because
 * `numberOfLines` caps a line count and not a line height: every text line
 * above grows with the scale. The gaps and paddings do not grow, so the
 * product over-reserves at a raised scale; over-reserving only adds blank
 * space, while under-reserving would move the copy. A state that shows fewer
 * surfaces keeps the difference as blank space after its own content, between
 * the pack surface and the copy, so no store answer, no purchase attempt and
 * no font scale moves the description or the legal links. The row count
 * follows the catalog, so a catalog that ever sells more packs widens the
 * reservation instead of pushing the copy down.
 */
const PACK_ROW_HEIGHT = 80;
const PACK_CONTENT_GAP = 10.5;
const STORE_NOTICE_HEIGHT = 180;
const PURCHASE_ERROR_HEIGHT = 35;
const packAreaMinHeight = (rows: number, fontScale: number): number =>
  (rows * (PACK_ROW_HEIGHT + PACK_CONTENT_GAP) +
    PACK_CONTENT_GAP +
    STORE_NOTICE_HEIGHT +
    PURCHASE_ERROR_HEIGHT) *
  fontScale;

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
  const storefront = getCreditStorefront();
  // Every text line the pack area reserves space for grows with the system
  // font scale, so the reservation does too; see `packAreaMinHeight`.
  const fontScale = useLiveFontScale();
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
    // Nothing to say when no part of the balance expires: a "no expiring
    // credits" line would repeat, in every state, the sentence each pack row
    // already carries. The slot keeps its height so the rows below it stay put
    // when this read settles.
    return (
      <CreditExpiryNote
        creditBlocks={creditBlocksQuery.data.creditBlocks}
        hiddenAmount={hideBalanceAmount ? HIDDEN_BALANCE : undefined}
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
            {/* The amount starts one 3.5 dp step under its label, as it did
                before this screen reserved the slot: the reservation sits
                below the value, never between the label and the value. */}
            <View className="mt-1 min-h-11 justify-start">{renderBalanceValue()}</View>
            <View className="mt-1 min-h-8 justify-center">{renderExpirySlot()}</View>
          </View>

          {/* The pack area holds one height in every state, and the description
              and the legal links follow it in this scroller. The store answers
              after the first frame — placeholder rows while it connects, the
              priced rows after, an empty card or the store's notice beside
              them — so an area sized by its content pushed the copy down the
              screen on every one of those swaps. The reservation covers the
              tallest state; a shorter state keeps the remainder as blank space
              after its own content, below the pack surface and above the copy.
              Its row count is the catalog's, so the placeholder count and the
              loaded count agree. */}
          <View
            className="gap-3"
            style={{
              minHeight: packAreaMinHeight(
                Math.max(PACK_SKELETON_ROWS, products.length),
                fontScale
              ),
            }}
          >
            {/* The purchase error rides inside the reserved area too: it comes
                and goes with a purchase attempt, and above the pack area it
                would move the copy for as long as it showed. Two lines is the
                height the reservation gives it, so a longer message truncates
                rather than growing the area. */}
            <AccessibleStatus
              message={purchaseErrorMessageKey ? t(purchaseErrorMessageKey) : null}
              className="px-1 text-sm"
              numberOfLines={2}
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
                <Text className="text-sm text-muted-foreground" numberOfLines={3}>
                  {t(storeBannerBodyKey)}
                </Text>
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
                      {/* One line each, which is the height the reservation
                        above assumes: a longer pack name or a longer price
                        truncates instead of making this row and the copy below
                        it taller. */}
                      <Text className="flex-1 font-semibold text-foreground" numberOfLines={1}>
                        {packLabel}
                      </Text>
                      <Text
                        className="text-base font-semibold text-foreground tabular-nums"
                        numberOfLines={1}
                      >
                        {priceLabel}
                      </Text>
                    </View>
                    {expiryMessage && (
                      <Text className="mt-2 text-xs text-muted-foreground">{expiryMessage}</Text>
                    )}
                  </Pressable>
                );
              })}
          </View>

          {/* The description and the two store legal links close the scroll
              content, after the last pack row. The two links are controls of
              their own, not words in the sentence above, so each carries the
              shared legal-link box: a real 48dp target the control-size audit
              can read, which keeps its height in the flow so the two boxes
              never overlap when a long locale wraps them onto two lines. */}
          <Text className="px-1 pt-1 text-xs text-muted-foreground">
            {t('credits.description')}
          </Text>
          <View className={cn('px-1', LEGAL_LINK_ROW_CLASS)}>
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
        </DetailScreenScrollView>
      </View>
    </View>
  );
}
