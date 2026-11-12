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
import {
  BALANCE_RETRY_FRAME_CLASS,
  BALANCE_RETRY_HIT_SLOP,
  LEGAL_LINK_BOX_CLASS,
  LEGAL_LINK_ROW_CLASS,
} from '@/lib/a11y/tap-target';
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
import { useScreenInsets, useSideInsetStyle } from '@/lib/screen-insets';
import { useHideBalancePreference } from '@/lib/hooks/use-hide-balance-preference';
import { getStoreLegalLinks } from '@/lib/iap/legal-links';
import { SETTLE_WHILE_OFFLINE } from '@/lib/query/settle-while-offline';
import { HIDDEN_BALANCE } from '@/lib/storage-keys';
import { useTRPC } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { useCreditNativeIap } from './credit-native-iap-owner';
import { CreditExpiryNote } from './credit-expiry-note';

/**
 * The room the scroller keeps at its end for the floating purchase error.
 *
 * Only the card's text scales, so only the text is multiplied: three capped
 * `text-sm` lines, then the card's own `py-3` and its border, then the gap
 * beneath it, which clears the home-indicator band. Multiplying the whole sum
 * would under-reserve at a scale below 1 and leave the copy under the card.
 *
 * Reserved in every state, so the copy can scroll above the card and the
 * clearance never depends on whether the error shows.
 */
const PURCHASE_ERROR_TEXT_HEIGHT = 63;
const PURCHASE_ERROR_CHROME = 26;
const purchaseErrorClearance = (fontScale: number, bottomInset: number): number =>
  PURCHASE_ERROR_TEXT_HEIGHT * fontScale +
  PURCHASE_ERROR_CHROME +
  // The gap under the card is the same one the card's own wrapper uses.
  Math.max(bottomInset, 16) +
  8;

/**
 * The balance card's data slots, at the default font scale.
 *
 * The card is the one block above the pack area whose content arrives late, so
 * it holds one height in every state of its two reads and the copy below never
 * moves. Two measured line boxes decide that height, and both are the text's
 * own box rather than extra space, so the card's bottom padding stays its
 * `py-4` and matches the top:
 *
 * - The amount's `text-2xl` line box: the value, the skeleton and the failed
 *   read's retry target are all one line of it.
 * - The expiry caption's `text-xs` lines: the caption paints in every state,
 *   so the only shape it can grow is the sentence's wrap, and the sentence
 *   wraps to two lines at this card's width in the catalog's measured styles.
 *
 * The reservation is a floor, not a cap: a catalog value that wraps one line
 * more grows the card by one line, which is the price of never truncating a
 * localized sentence. The line boxes scale with the system font size; the
 * spacing between them stays fixed, as in the rows.
 */
const BALANCE_AMOUNT_LINE_HEIGHT = 28.2;
const EXPIRY_LINE_HEIGHT = 14.1;
const EXPIRY_CAPTION_LINES = 2;

/**
 * The caption's floor at a font scale. The card's width does not change, so a
 * raised scale fits fewer characters per line: the sentence's line count grows
 * with the scale, and the floor counts those lines before it multiplies each
 * one's height. Reserving only the scaled height of two lines would let the
 * caption outgrow the floor and move the copy below.
 */
function expiryCaptionFloor(fontScale: number): number {
  return Math.ceil(EXPIRY_CAPTION_LINES * fontScale) * EXPIRY_LINE_HEIGHT * fontScale;
}

/** Reserved pack-row space while the store connects, so rows never jump in. */
const PACK_SKELETON_ROWS = 4;

/**
 * The height the pack area holds, at the default font scale.
 *
 * The pack surface shows one of four mutually exclusive things: placeholder
 * rows while the store connects, the priced rows, the empty-catalogue card, or
 * the store's notice. They share one slot sized to the tallest of them, the
 * row list, so the description and the legal links below it keep their place
 * when the store answers, and the normal state has no blank band because the
 * rows fill the slot.
 *
 * The shorter cards are laid out inside the slot from its top, so the space
 * they leave stays below them rather than moving the copy.
 *
 * A row's height is its text plus its spacing. The text is one line of title
 * with the price beside it and one line of expiry, each capped; only that text
 * grows with the system font scale, so only it is multiplied. The spacing —
 * the row's 20 dp paddings and the 8 dp gap above the expiry line, plus the
 * column's 10.5 dp step between rows — is fixed.
 */
const PACK_ROW_TEXT_HEIGHT = 35.4;
const PACK_ROW_SPACING = 44.2;
const PACK_CONTENT_GAP = 10.5;

/** One row's height at the live font scale. */
const packRowHeight = (fontScale: number): number =>
  PACK_ROW_TEXT_HEIGHT * fontScale + PACK_ROW_SPACING;

/**
 * The slot's height for `rows` rows: the tallest state the pack area shows.
 * A card that replaces the rows is laid out inside this height.
 */
const packSlotHeight = (rows: number, fontScale: number): number =>
  rows === 0 ? 0 : rows * packRowHeight(fontScale) + (rows - 1) * PACK_CONTENT_GAP;

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
  // The error overlay sits outside the scroller, so it takes the side insets
  // the scroller applies to its own content.
  const sideInsetStyle = useSideInsetStyle();
  // The error overlay must stay out of the home-indicator band.
  const { bottom: bottomInset } = useScreenInsets();
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
  // The pack surface shows one of five things at a time: the account read's
  // failure, the store's notice, the empty catalogue, the placeholder rows or
  // the priced rows. They are exclusive so the slot paints one surface and the
  // copy below it never sees two stacked.
  const storeUnavailableAlone = storeUnavailable && !identityUnavailable;
  const showPlaceholders = isLoading && !identityUnavailable && !storeUnavailable;
  const showRows = !isLoading && !identityUnavailable && !storeUnavailable && !packsEmpty;
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
    // Every branch below is one `h-8` tall, the amount's own line box: the
    // card's height stays the same in all three states, so the copy below it
    // never moves when the read settles. The skeleton keeps the value's box,
    // and the failed read's target keeps the box too: its tap area comes from
    // the hit slop, not from a taller box, which would move the copy.
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
    // Every state paints one caption inside the same floor: the sentence, the
    // "no expiring credits" line the Profile credits card also shows, "expiry
    // unavailable" when the read fails, or the skeleton. The floor counts the
    // lines the sentence wraps to in this card's width, and the caption
    // centres inside it, so the card's padding stays its `py-4` at both edges
    // and the copy below never moves.
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
          // The trailing clearance for the error overlay is a child of the
          // content, not `contentContainerStyle`: that style prop makes
          // NativeWind drop this scroller's `contentContainerClassName`, and
          // it would take the content gap and gutter with it.
        >
          {/* The card holds both of its data slots in every state, so a
              settling read changes what the slots paint, never the card's
              height: the amount keeps its own line box (a skeleton, the value,
              or the failed read's retry target), and the caption keeps the two
              lines its sentence wraps to. Both reservations are the text's
              line box, so the card's `py-4` stays balanced top and bottom. */}
          <View className="rounded-xl border border-border bg-card px-5 py-4">
            <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
              {t('profile.credits')}
            </Text>
            {/* The amount starts one 3.5 dp step under its label, as it did
                before this screen reserved the slot: the reservation sits
                below the value, never between the label and the value. */}
            <View
              className="mt-1 justify-center"
              style={{ minHeight: BALANCE_AMOUNT_LINE_HEIGHT * fontScale }}
              testID="credit-balance-slot"
            >
              {renderBalanceValue()}
            </View>
            {/* The caption is centred in its two-line floor: a one-line
                caption splits the line it does not use above and below, so the
                card's bottom edge keeps the same distance from the text as its
                top edge does. Anchoring it to either end would put the whole
                unused line on one side and read as a band. A longer locale's
                sentence grows the floor instead of truncating. */}
            <View
              className="mt-1 justify-center"
              style={{ minHeight: expiryCaptionFloor(fontScale) }}
              testID="credit-expiry-slot"
            >
              {renderExpirySlot()}
            </View>
          </View>

          {/* The pack surface shows exactly one of four things — placeholder
              rows while the store connects, the priced rows, the empty
              catalogue card, or the store's notice — and they share one slot
              sized to the row list. The description and the legal links follow
              that slot, so a store answer changes what the slot paints without
              moving them, and the normal state leaves no blank band because the
              rows fill the slot. A shorter card starts at the slot's top. */}
          <View
            className="gap-3"
            style={{
              minHeight: packSlotHeight(Math.max(PACK_SKELETON_ROWS, products.length), fontScale),
            }}
          >
            {/* The account read gates both catalogue reads, so its failure is
                the one state where nothing else can settle. It gets the same
                card shape as the store's failure, with its own retry: an empty
                pack area would read as "nothing for sale" and offer no way
                back. */}
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

            {storeUnavailableAlone && (
              <View className="gap-3 rounded-xl border border-border bg-card p-5">
                <Text className="font-semibold text-foreground" numberOfLines={2}>
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

            {showPlaceholders &&
              Array.from({ length: PACK_SKELETON_ROWS }, (_, index) => (
                <View
                  key={index}
                  className="justify-center rounded-xl border border-border bg-card px-5"
                  style={{ height: packRowHeight(fontScale) }}
                  testID="credit-pack-placeholder"
                >
                  <View className="flex-row items-start justify-between gap-4">
                    <Skeleton className="h-6 flex-1 rounded" />
                    <Skeleton className="h-6 w-16 rounded" />
                  </View>
                  <Skeleton className="mt-2 h-8 w-full rounded" />
                </View>
              ))}

            {showRows &&
              products.map(pack => {
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
                const priceLabel = rowCompleting
                  ? t('kiloPass.completingPurchase')
                  : (pack.displayPrice ?? t('credits.priceUnavailable'));
                // The row is one accessible element: the explicit label replaces
                // its children, so the charge and the disabled reason must be in
                // the label itself (the canonical Kilo Pass row does the same).
                // It also carries the full expiry sentence, which the row paints
                // on one capped line.
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
                      'justify-center rounded-xl border border-border bg-card px-5 active:opacity-80',
                      disabled && 'opacity-50'
                    )}
                    disabled={disabled}
                    onPress={() => {
                      handlePackPress(pack);
                    }}
                    style={{ height: packRowHeight(fontScale) }}
                    testID="credit-pack-row"
                  >
                    {/* Every line is capped at the count the row's height
                        reserves, so a longer pack name, price or expiry
                        sentence truncates instead of growing the row. */}
                    <View className="flex-row items-start justify-between gap-4">
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
                      <Text className="mt-2 text-xs text-muted-foreground" numberOfLines={1}>
                        {expiryMessage}
                      </Text>
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

          {/* The room the floating purchase error needs at the end of the
              content, as a child of the content rather than a container style
              (see the scroller's comment). It scales with the text, because the
              card it clears does. */}
          <View style={{ height: purchaseErrorClearance(fontScale, bottomInset) }} />
        </DetailScreenScrollView>
        {/* The purchase error floats above the bottom of the scroll area. It
            is not one of the four pack states, so it takes no layout height,
            and the live region stays the announcement channel the store sheet
            leaves available. Two wrappers keep the pieces apart: the outer one
            adds the safe-area side insets to the gutter, and the inner one
            carries the gutter itself, because an inline padding on one node
            replaces its className padding. The scroller keeps a trailing
            clearance so the last content can scroll clear of the card. */}
        <View className="pointer-events-none absolute inset-x-0 bottom-0" style={sideInsetStyle}>
          {/* The card clears the home indicator: the bottom inset is the
              gesture area, and the card's text must not sit in it. */}
          <View className="px-5" style={{ paddingBottom: Math.max(bottomInset, 16) + 8 }}>
            <AccessibleStatus
              message={purchaseErrorMessageKey ? t(purchaseErrorMessageKey) : null}
              className="rounded-xl border border-destructive bg-card px-4 py-3 text-sm"
              numberOfLines={3}
            />
          </View>
        </View>
      </View>
    </View>
  );
}
