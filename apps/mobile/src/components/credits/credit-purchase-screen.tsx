/* eslint-disable max-lines -- The Buy credits screen composes the store banner, loading, empty, error, and pack-row surfaces; each is a small rendered surface that mirrors the shared header/scroll pattern. */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { selectionHaptic } from '@/lib/haptics';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, useWindowDimensions, View } from 'react-native';
import { toast } from 'sonner-native';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { ScreenHeader } from '@/components/screen-header';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Wallet } from '@/components/ui/icons';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { ScreenFooter } from '@/components/ui/screen-footer';
import { Section } from '@/components/ui/section';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  BALANCE_RETRY_FRAME_CLASS,
  BALANCE_RETRY_HIT_SLOP,
  LEGAL_LINK_BOX_CLASS,
  LEGAL_LINK_ROW_CLASS,
} from '@/lib/a11y/tap-target';
import { isolateLtrBidiText } from '@/lib/bidi';
import { getStoreUnavailableCopyKeys } from '@/lib/credits/store-products-loader';
import {
  getStoreCreditExpiryMessageKey,
  type StoreCreditProduct,
} from '@/lib/credits/store-products';
import { useStoreCreditProducts } from '@/lib/credits/use-store-credit-products';
import { getCreditStorefront } from '@/lib/credits/storefront';
import { useInlinePurchaseErrorOwnership } from '@/lib/credits/use-store-credit-purchase';
import { formatPrefixedMoney } from '@/lib/format';
import { useLiveFontScale } from '@/lib/font-scale/system-font-scale-context';
import { useSideInsetStyle } from '@/lib/screen-insets';
import { useHideBalancePreference } from '@/lib/hooks/use-hide-balance-preference';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { type LegalDocument } from '@/lib/legal-document';
import { SETTLE_WHILE_OFFLINE } from '@/lib/query/settle-while-offline';
import { isNarrowLayout } from '@/lib/narrow-layout';
import { HIDDEN_BALANCE } from '@/lib/storage-keys';
import { useTRPC } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { type CreditPurchaseWait, useCreditNativeIap } from './credit-native-iap-owner';
import { CreditUnresolvedPurchaseNotice } from './credit-unresolved-purchase-notice';
import { CreditExpiryNote } from './credit-expiry-note';

/**
 * The room the scroller keeps at its end for the floating purchase error.
 *
 * Only the card's text scales, so only the text is multiplied: three capped
 * `text-sm` lines, then the card's own padding, then the 8 dp gap its wrapper
 * keeps above the footer. Multiplying the whole sum would under-reserve at a
 * scale below 1 and leave the content under the card. The home-indicator band
 * is not part of the sum: the footer below the scroller owns it.
 */
const PURCHASE_ERROR_TEXT_HEIGHT = 63;
const PURCHASE_ERROR_CHROME = 28;
const purchaseErrorClearance = (fontScale: number): number =>
  PURCHASE_ERROR_TEXT_HEIGHT * fontScale + PURCHASE_ERROR_CHROME + 8;

/**
 * The balance card's data slots, at the default font scale.
 *
 * The card is the one block above the pack area whose content arrives late, so
 * it holds one height in every state of its two reads and the packs below never
 * move. Both floors are the text's own line box rather than extra space: the
 * amount's `figure` line (the value, its skeleton or the failed read's retry
 * target) and the expiry caption's two lines. The reservation is a floor, not a
 * cap, and it scales with the system font size.
 */
const BALANCE_AMOUNT_LINE_HEIGHT = 28.2;
const EXPIRY_LINE_HEIGHT = 14.1;
const EXPIRY_CAPTION_LINES = 2;

/** The caption's floor at a font scale: a raised scale fits fewer characters per line. */
function expiryCaptionFloor(fontScale: number): number {
  return Math.ceil(EXPIRY_CAPTION_LINES * fontScale) * EXPIRY_LINE_HEIGHT * fontScale;
}

/** Reserved pack-row space while the store connects, so rows never jump in. */
const PACK_SKELETON_ROWS = 4;

/**
 * The scale at which `ConfigureRow` stacks its tile above the copy, shared with
 * the loading placeholder so the reservation and the row it stands in for take
 * the same shape. `configure-row.tsx` keeps the number itself.
 */
const CONFIGURE_ROW_STACK_FONT_SCALE = 1.8;

/** The row and the pending card say the same thing about a waiting request. */
const WAIT_COPY_KEYS = {
  store: 'credits.waitingForStore',
  pending: 'credits.purchasePending',
} as const satisfies Record<CreditPurchaseWait['kind'], string>;

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
  // The footer and the error overlay sit outside the scroller, so they take the
  // side insets the scroller applies to its own content.
  const sideInsetStyle = useSideInsetStyle();
  const fontScale = useLiveFontScale();
  const { width } = useWindowDimensions();
  // The same presentation `ConfigureRow` picks for the loaded rows: a narrow
  // window or a large Dynamic Type scale hands the copy the row's full width,
  // so the loading placeholder reserves that shape instead of a shorter one.
  const stackRows = fontScale >= CONFIGURE_ROW_STACK_FONT_SCALE || isNarrowLayout(width);
  const trpc = useTRPC();
  const {
    connected,
    fetchStoreProducts,
    purchase,
    reconnectStore,
    completingProductId,
    purchaseWait,
    reconcilePurchase,
    buyAgain,
    buyAgainProductId,
    hasUnresolvedPurchase,
    purchaseResolution,
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

  const router = useRouter();
  // The two legal documents open in their own native screens: a store purchase
  // surface must not hand the reader a browser that can reach web pricing.
  const openLegalDocument = (document: LegalDocument) => {
    router.push({ pathname: '/(app)/legal/[document]', params: { document } });
  };

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
  const waitCopy = purchaseWait ? t(WAIT_COPY_KEYS[purchaseWait.kind]) : null;
  // Only a catalog the backend answered as empty is the empty state: a store
  // query that is pending, paused or failed must not hide the packs the backend
  // catalog named.
  const packsEmpty = !isLoading && catalogEmpty;
  // The pack area holds at most one card at a time — the account read's
  // failure, the store's notice or the empty catalogue — and the priced rows
  // render under it whenever the catalogue answered, also while the store is
  // unavailable or timed out: the store's notice names that failure, and the
  // rows stay on screen unpriced and disabled. The account read gates the
  // catalogue, so its failure replaces the whole pack area.
  const storeUnavailableAlone = storeUnavailable && !identityUnavailable;
  const showPlaceholders = isLoading && !identityUnavailable && !storeUnavailable;
  const showRows = !isLoading && !identityUnavailable && !packsEmpty;
  const balancePending = balanceQuery.isPending;
  const balanceFailed = balanceQuery.isError;
  // The card's title and its default body come from one per-store source, so
  // an iOS build can never name Google Play (or the reverse) for only one of
  // the two lines.
  const storeUnavailableCopy = getStoreUnavailableCopyKeys(storefront);
  const storeBannerBodyKey = productsErrorMessageKey ?? storeUnavailableCopy.bodyKey;

  // The consent target is the pack the owner selected from the current
  // catalog, never the earlier request's own id: a retired SKU has no row to
  // name and no price to show, while the replacement the person picked is the
  // exact charge a second tap would start.
  const buyAgainTarget =
    buyAgainProductId === null
      ? null
      : (products.find(pack => pack.storeProductId === buyAgainProductId) ?? null);
  // Buy again names one exact charge only once the store priced that pack.
  const buyAgainAvailable = buyAgainTarget !== null && buyAgainTarget.displayPrice !== null;
  // The card's retry is a store query and its consent is a row tap: neither
  // needs the store connection the rows do, so only a purchase in flight
  // disables them.
  const statusActionsDisabled = purchasing;

  // One label source for the row and the card: the pack amount reads the same
  // on both, so consent names the same pack the list sells.
  const formatPackLabel = (pack: StoreCreditProduct) =>
    t('credits.packLabel', {
      amount: isolateLtrBidiText(formatPrefixedMoney(pack.backend.amountUsd, i18n.language)),
    });

  const handleReconcilePress = () => {
    selectionHaptic();
    clearError();
    void reconcilePurchase();
  };

  const handleBuyAgainPress = () => {
    if (buyAgainTarget === null) {
      return;
    }
    selectionHaptic();
    clearError();
    void buyAgain(buyAgainTarget);
  };

  const handlePackPress = (pack: StoreCreditProduct) => {
    selectionHaptic();
    clearError();
    void purchase(pack);
  };

  const renderBalanceValue = () => {
    // Each branch is one `figure` line box: the amount's own, so the card's
    // height stays the same and the packs below never move when the read
    // settles. The failed read's target keeps that box too: its tap area comes
    // from the hit slop, not from a taller box.
    if (balancePending) {
      return <Skeleton className="h-8 w-24 rounded" />;
    }
    if (balanceFailed) {
      return (
        <Pressable
          accessibilityLabel={t('profile.failedToLoadBalance')}
          accessibilityRole="button"
          className={cn(BALANCE_RETRY_FRAME_CLASS, 'justify-center active:opacity-70')}
          hitSlop={BALANCE_RETRY_HIT_SLOP}
          onPress={() => {
            void refetchBalance();
          }}
        >
          <Text className="text-destructive">{t('profile.failedToLoadBalance')}</Text>
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
        variant="figure"
        accessibilityLabel={hideBalanceAmount ? t('profile.balanceHidden') : balanceAmount}
      >
        {hideBalanceAmount ? HIDDEN_BALANCE : isolateLtrBidiText(balanceAmount)}
      </Text>
    );
  };

  const renderExpirySlot = () => {
    // Every state paints one caption: the sentence, the "no expiring credits"
    // line the Profile credits card also shows, "expiry unavailable" when the
    // read fails, or the skeleton. A longer locale wraps the caption and grows
    // the card instead of truncating it.
    if (creditBlocksQuery.isError) {
      return <Text variant="caption">{t('credits.expiryUnavailable')}</Text>;
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
      <View className="flex-1">
        <DetailScreenScrollView
          className="flex-1"
          contentContainerClassName={SCREEN_BODY_CLASS}
          showsVerticalScrollIndicator={false}
          // The trailing clearance for the error overlay is a child of the
          // content, not `contentContainerStyle`: that style prop makes
          // NativeWind drop this scroller's `contentContainerClassName`, and
          // it would take the content gap and gutter with it.
        >
          {/* The card holds both of its data slots in every state, so a
              settling read changes what the slots paint, never the card's
              shape: the amount is one `figure` line (a skeleton, the value, or
              the failed read's retry target), and the caption wraps by design. */}
          <Section label={t('profile.credits')}>
            <Card>
              {/* Each slot keeps its line-height floor in every state, so the
                  card's height is the same whether the read is pending, failed
                  or settled and the packs below never move when it answers. */}
              <View
                className="justify-center"
                style={{ minHeight: BALANCE_AMOUNT_LINE_HEIGHT * fontScale }}
                testID="credit-balance-slot"
              >
                {renderBalanceValue()}
              </View>
              <View
                className="justify-center"
                style={{ minHeight: expiryCaptionFloor(fontScale) }}
                testID="credit-expiry-slot"
              >
                {renderExpirySlot()}
              </View>
            </Card>
          </Section>

          {/* The pack area holds at most one card — the account read's
              failure, the store's notice or the empty catalogue — in flow
              directly under the balance card, and the priced rows render under
              it whenever the catalogue answered, also while the store is
              unavailable. The description and the legal links are pinned in the
              footer below the scroller, so a shorter state ends sooner instead
              of leaving a reserved blank band under it, while the placeholder
              rows keep exactly the priced row's height so the list never jumps
              when the store answers. */}
          <View className="gap-3">
            {/* The account read gates both catalogue reads, so its failure is
                the one state where nothing else can settle. It keeps the store
                failure's card shape, with its own retry: an empty pack area
                would read as "nothing for sale" and offer no way back. */}
            {identityUnavailable && (
              <Card>
                <Text variant="heading">{t('queryError.serverTitle')}</Text>
                <Text variant="muted">{t('organization.boundary.loadErrorMessage')}</Text>
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
              </Card>
            )}

            {storeUnavailableAlone && (
              <Card>
                <Text variant="heading" numberOfLines={2}>
                  {t(storeUnavailableCopy.titleKey)}
                </Text>
                <Text variant="muted" numberOfLines={3}>
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
              </Card>
            )}

            {packsEmpty && !hasUnresolvedPurchase && (
              <Card>
                <Text variant="muted">{t('credits.empty')}</Text>
              </Card>
            )}

            {showPlaceholders && (
              <RowGroup>
                {Array.from({ length: PACK_SKELETON_ROWS }, (_, index) => (
                  <View key={index} testID="credit-pack-placeholder">
                    <RowSkeleton tile subtitle stack={stackRows} />
                  </View>
                ))}
              </RowGroup>
            )}

            {showRows && (
              <RowGroup leadingTile>
                {products.map(pack => {
                  // The pack names a credit amount in the same shape as the
                  // balance above it. The store's own localized price stays as
                  // the store wrote it.
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
                  // The trailing slot holds the store price only: it keeps its one
                  // line, so the title yields and a price a user pays is never
                  // truncated.
                  const storePrice = hasStorePrice ? pack.displayPrice : null;
                  // The row's subtitle holds one state phrase, in place of the
                  // expiry note. The store-unavailable card above already names
                  // the failure, so only the partly priced state, where the store
                  // answered and left this pack out, needs the row to say it.
                  const rowWaiting = purchaseWait?.productId === pack.storeProductId;
                  let completingLabel: string | null = null;
                  if (rowWaiting) {
                    completingLabel = waitCopy;
                  } else if (rowCompleting) {
                    completingLabel = t('kiloPass.completingPurchase');
                  }
                  const statusLabel =
                    !rowCompleting && !hasStorePrice && !storeUnavailable
                      ? t('credits.priceUnavailable')
                      : null;
                  // Exactly one state phrase shows: the purchase in flight, or the
                  // reason this row is inactive.
                  const stateLabel = completingLabel ?? statusLabel;
                  // The row is one accessible element: the explicit label replaces
                  // its children, so the charge and the disabled reason must be in
                  // the label itself (the canonical Kilo Pass row does the same).
                  // The price the row still shows stays in the label while a
                  // purchase is open, and the state is never dropped, also when the
                  // card above is its only visible statement.
                  const rowAccessibilityLabel = [
                    packLabel,
                    storePrice,
                    stateLabel,
                    storePrice === null && stateLabel === null
                      ? t('credits.priceUnavailable')
                      : null,
                    expiryMessage,
                  ]
                    .filter(Boolean)
                    .join(', ');

                  return (
                    <Pressable
                      key={pack.backend.appleProductId}
                      accessibilityLabel={rowAccessibilityLabel}
                      accessibilityRole="button"
                      accessibilityState={{ busy: rowCompleting, disabled }}
                      className={!disabled ? 'active:opacity-70' : undefined}
                      disabled={disabled}
                      onPress={() => {
                        handlePackPress(pack);
                      }}
                      testID="credit-pack-row"
                    >
                      <ConfigureRow
                        icon={Wallet}
                        title={packLabel}
                        subtitle={stateLabel ?? expiryMessage}
                        // One line under the title, capped by the row frame:
                        // the state phrase or expiry note never wraps into a
                        // second line, so no row changes height when a purchase
                        // or the store state changes. The full note stays in the
                        // row's accessibility label.
                        subtitleNumberOfLines={1}
                        variant="action"
                        disabled={disabled}
                        trailing={
                          storePrice === null ? null : (
                            <Text variant="small" className="tabular-nums">
                              {storePrice}
                            </Text>
                          )
                        }
                      />
                    </Pressable>
                  );
                })}
              </RowGroup>
            )}
          </View>

          {/* The purchase state is its own slot after the pack rows: a request
              the store has not answered yet, or the barrier an unresolved charge
              leaves. It sits below the rows so its arrival, change or removal
              never moves one, and the footer copy stays pinned outside the
              scroller. */}
          <View className="gap-3">
            {hasUnresolvedPurchase ? (
              <CreditUnresolvedPurchaseNotice
                actionsDisabled={statusActionsDisabled}
                buyAgainAvailable={buyAgainAvailable}
                onBuyAgain={handleBuyAgainPress}
                onReconcile={handleReconcilePress}
                packLabel={buyAgainTarget !== null ? formatPackLabel(buyAgainTarget) : null}
                priceLabel={
                  buyAgainTarget !== null
                    ? (buyAgainTarget.displayPrice ?? t('credits.priceUnavailable'))
                    : null
                }
                resolution={purchaseResolution}
                waitCopy={waitCopy}
              />
            ) : (
              waitCopy !== null && (
                <Card testID="credit-purchase-wait-card">
                  <AccessibleStatus className="text-sm" message={waitCopy} />
                </Card>
              )
            )}
          </View>

          {/* The room the floating purchase error needs at the end of the
              content, as a child of the content rather than a container style
              (see the scroller's comment). It exists only while that card does,
              so the last content reaches the end of the scroller otherwise. */}
          {purchaseErrorMessageKey !== null && (
            <View style={{ height: purchaseErrorClearance(fontScale) }} />
          )}
        </DetailScreenScrollView>
        {/* The purchase error floats above the bottom of the scroll area. It
            is not one of the four pack states, so it takes no layout height,
            and the live region stays the announcement channel the store sheet
            leaves available. The scroller keeps a trailing clearance so the
            last content can scroll clear of the card, and the footer below
            this area clears the home indicator. */}
        {purchaseErrorMessageKey !== null && (
          <View className="pointer-events-none absolute inset-x-0 bottom-0" style={sideInsetStyle}>
            <View className="px-4 pb-2">
              <Card>
                <AccessibleStatus message={t(purchaseErrorMessageKey)} numberOfLines={3} />
              </Card>
            </View>
          </View>
        )}
      </View>
      {/* The description and the store's legal links are the screen's pinned
          footer, outside the scroll view and below the scroll area. The pack
          area answers late — placeholder rows while the store connects, the
          priced rows after, an empty card or the unavailable card instead — so
          copy written under it inside the scroller is pushed by every one of
          those swaps. `ScreenFooter` owns the gutter, the hairline and the
          home-indicator band in every state and locale.

          The two links are controls of their own, not words in the sentence
          above, so each carries the shared legal-link box: a real 48dp target
          the control-size audit can read, which keeps its height in the flow so
          the two boxes never overlap when a long locale wraps them onto two
          lines. */}
      <ScreenFooter>
        <Text variant="caption">{t('credits.description')}</Text>
        <View className={LEGAL_LINK_ROW_CLASS}>
          <Pressable
            accessibilityRole="link"
            className={cn(LEGAL_LINK_BOX_CLASS, 'active:opacity-70')}
            onPress={() => {
              openLegalDocument('terms');
            }}
          >
            <Text variant="caption" className="text-primary underline">
              {t('kiloPass.legalTermsOfUse')}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="link"
            className={cn(LEGAL_LINK_BOX_CLASS, 'active:opacity-70')}
            onPress={() => {
              openLegalDocument('privacy');
            }}
          >
            <Text variant="caption" className="text-primary underline">
              {t('common.privacyPolicy')}
            </Text>
          </Pressable>
        </View>
      </ScreenFooter>
    </View>
  );
}
