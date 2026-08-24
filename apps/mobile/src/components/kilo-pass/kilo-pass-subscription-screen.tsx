/* eslint-disable max-lines -- The Kilo Pass screen composes the presentation gate, loading, error, unavailable, and native-IAP surfaces; each is a small rendered surface that mirrors the shared header/scroll pattern. */
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Platform, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { WEB_BASE_URL } from '@/lib/config';
import { openExternalUrl } from '@/lib/external-link';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getKiloPassLegalLinks, KILO_PASS_LEGAL_DISCLOSURE } from '@/lib/kilo-pass/legal-links';
import { ensureProfileAfterKiloPassPurchase } from '@/lib/kilo-pass/navigation';
import { type AppStoreKiloPassProduct } from '@/lib/kilo-pass/store-products';
import { useInlinePurchaseErrorOwnership } from '@/lib/kilo-pass/use-store-kilo-pass-purchase';
import { useTRPC } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import {
  KILO_PASS_MANAGE_CTA_LABEL,
  KILO_PASS_TITLE,
  KILO_PASS_UNAVAILABLE_DESCRIPTION,
  KILO_PASS_WEB_MANAGEMENT_DESCRIPTION,
  type PurchasePresentationKind,
} from '@kilocode/app-shared/commerce';
import { KiloPassNativeIapOwner, useKiloPassNativeIap } from './kilo-pass-native-iap-owner';
import { RestorePurchasesButton } from './restore-purchases-button';

type SubscriptionScreenFeedback = { type: 'success' | 'info' | 'error'; text: string };

/**
 * A failed preflight is either retryable (transient network/5xx) or
 * non-retryable (the server refused the purchase). The retryable variant keeps
 * the product so the "Try again" CTA can re-run preflight without starting IAP.
 */
type PreflightFailure =
  | { kind: 'retryable'; message: string; product: AppStoreKiloPassProduct }
  | { kind: 'nonRetryable'; message: string };

function getPreflightFailureMessage(reason: string | null): string {
  if (reason === 'already_subscribed') {
    return i18n.t('kiloPass.alreadySubscribed');
  }
  if (reason === 'owned_by_another_account') {
    return i18n.t('kiloPass.otherAccountCopy');
  }
  return i18n.t('kiloPass.purchaseUnavailable');
}

function formatTier(product: AppStoreKiloPassProduct): string {
  return i18n.t('kiloPass.tierCredits', { amount: product.webMonthlyPriceUsd });
}

function formatStorePrice(product: AppStoreKiloPassProduct): string {
  return i18n.t('kiloPass.perMonth', { price: product.displayPrice });
}

function KiloPassLoadingScreen() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('kiloPass.title')} modal />
      <View className="flex-1 px-5">
        <DetailScreenScrollView
          className="-mx-1 flex-1"
          contentContainerClassName="gap-3 px-1"
          showsVerticalScrollIndicator={false}
        >
          <Skeleton className="h-4 w-64 rounded" />
          {[0, 1, 2].map(index => (
            <Skeleton key={index} className="h-[112px] w-full rounded-xl" />
          ))}
        </DetailScreenScrollView>
      </View>
    </View>
  );
}

function KiloPassPresentationErrorScreen({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('kiloPass.title')} modal />
      <View className="flex-1 items-center justify-center gap-3 px-6">
        <Text className="text-center font-semibold text-foreground">
          {t('kiloPass.unavailable')}
        </Text>
        <Text className="text-center text-sm text-muted-foreground">
          {t('kiloPass.couldNotLoad')}
        </Text>
        <Button accessibilityLabel={t('kiloPass.retryLoading')} onPress={onRetry} variant="outline">
          <Text>{t('common.retry')}</Text>
        </Button>
      </View>
    </View>
  );
}

/**
 * Rendered when the server presentation is not `native_iap`. Shows truthful
 * copy and, for `web_management`, a Manage action that opens the web URL.
 * Never imports `expo-iap`, so Android never initializes Play Billing here.
 */
function KiloPassUnavailableScreen({
  presentation,
}: {
  presentation: { kind: PurchasePresentationKind; webUrl: string | null };
}) {
  const { t } = useTranslation();
  const isWebManagement = presentation.kind === 'web_management';
  const description = isWebManagement
    ? KILO_PASS_WEB_MANAGEMENT_DESCRIPTION
    : KILO_PASS_UNAVAILABLE_DESCRIPTION;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('kiloPass.title')} modal />
      <View className="flex-1 px-5">
        <DetailScreenScrollView
          className="-mx-1 flex-1"
          contentContainerClassName="gap-3 px-1"
          showsVerticalScrollIndicator={false}
        >
          <Text className="px-1 text-sm leading-5 text-muted-foreground">
            {t('kiloPass.subscriptionHeaderDescription')}
          </Text>
          <View className="rounded-xl border border-border bg-card p-5">
            <Text className="font-semibold text-foreground">{KILO_PASS_TITLE}</Text>
            <Text className="mt-1 text-sm text-muted-foreground">{description}</Text>
            {isWebManagement && presentation.webUrl ? (
              <Button
                accessibilityLabel={KILO_PASS_MANAGE_CTA_LABEL}
                className="mt-4 self-start"
                onPress={() => {
                  if (!presentation.webUrl) {
                    return;
                  }
                  void openExternalUrl(presentation.webUrl, {
                    label: t('kiloPass.kiloPassManagement'),
                  });
                }}
                variant="outline"
              >
                {KILO_PASS_MANAGE_CTA_LABEL}
              </Button>
            ) : null}
          </View>
        </DetailScreenScrollView>
      </View>
    </View>
  );
}

function KiloPassNativeIapContent() {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const trpc = useTRPC();
  const { t } = useTranslation();
  const {
    clearError,
    errorMessage,
    isPending,
    products,
    productsError,
    productsIsLoading,
    productsIsRefetching,
    productsRefetch,
    purchase,
    ownedByAnotherAccount,
    ownedAppleProductId,
    ownedOriginalTransactionId,
    ownershipChecked,
  } = useKiloPassNativeIap();
  useInlinePurchaseErrorOwnership();
  const queryClient = useQueryClient();
  const preflightPurchase = useMutation(trpc.kiloPass.preflightPurchase.mutationOptions());
  const invalidateAfterManagement = async () => {
    await Promise.all([
      queryClient.invalidateQueries(trpc.kiloPass.getState.pathFilter()),
      queryClient.invalidateQueries(trpc.user.getContextBalance.pathFilter()),
      queryClient.invalidateQueries(trpc.kiloPass.getPurchasePresentation.pathFilter()),
    ]);
  };
  const [restoreFeedback, setRestoreFeedback] = useState<SubscriptionScreenFeedback | null>(null);
  const [preflightFailure, setPreflightFailure] = useState<PreflightFailure | null>(null);
  let feedback: SubscriptionScreenFeedback | null = restoreFeedback;
  if (ownedByAnotherAccount) {
    feedback = { type: 'error', text: t('kiloPass.otherAccountCopy') };
  } else if (errorMessage) {
    feedback = { type: 'error', text: errorMessage };
  } else if (preflightFailure) {
    feedback = { type: 'error', text: preflightFailure.message };
  }
  const preflightBlocked = preflightFailure?.kind === 'nonRetryable';
  const isRetryDisabled = isPending || productsIsRefetching;
  const tilesDisabled =
    isPending ||
    preflightBlocked ||
    preflightPurchase.isPending ||
    ownedByAnotherAccount ||
    !ownershipChecked;
  const [privacyPolicyLink, termsOfUseLink] = getKiloPassLegalLinks(WEB_BASE_URL);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(
    () => () => {
      clearError();
    },
    [clearError]
  );

  const runPreflight = async (product: AppStoreKiloPassProduct) => {
    setPreflightFailure(null);
    // eslint-disable-next-line init-declarations -- assigned in the try block below
    let preflight: Awaited<ReturnType<typeof preflightPurchase.mutateAsync>>;
    try {
      preflight = await preflightPurchase.mutateAsync({
        platform: 'ios',
        storefront: 'app_store',
        product: 'kilo_pass',
        appleProductId: product.appleProductId,
        appleOriginalTransactionId: ownedOriginalTransactionId,
      });
    } catch {
      setPreflightFailure({
        kind: 'retryable',
        message: t('kiloPass.verifyPurchaseFailed'),
        product,
      });
      return;
    }

    if (!preflight.allowed) {
      setPreflightFailure({
        kind: 'nonRetryable',
        message: getPreflightFailureMessage(preflight.reason),
      });
      return;
    }

    if (!mountedRef.current) {
      return;
    }

    await purchase(product, {
      onCompleted: () => {
        ensureProfileAfterKiloPassPurchase(router);
      },
    });
  };

  const handleProductPress = (product: AppStoreKiloPassProduct) => {
    void Haptics.selectionAsync();

    // Apple owns tier changes inside a subscription group: requesting another SKU
    // while this device already owns one is refused by StoreKit, and the app cannot
    // show the proration Apple applies. Send those taps to App Store management.
    if (ownedAppleProductId && ownedAppleProductId !== product.appleProductId) {
      void (async () => {
        const { openAppStoreManagement } = await import('./kilo-pass-ios-manage');
        await openAppStoreManagement({ invalidateAfter: invalidateAfterManagement });
      })();
      return;
    }

    void runPreflight(product);
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('kiloPass.title')} modal />
      <View className="flex-1 px-5">
        <DetailScreenScrollView
          className="-mx-1 flex-1"
          contentContainerClassName="gap-3 px-1"
          showsVerticalScrollIndicator={false}
        >
          <Text className="px-1 text-sm leading-5 text-muted-foreground">
            {t('kiloPass.subscriptionHeaderDescription')}
          </Text>

          {feedback && (
            <Text
              className={cn('px-1 text-sm', {
                'text-destructive': feedback.type === 'error',
                'text-good': feedback.type === 'success',
                'text-muted-foreground': feedback.type === 'info',
              })}
            >
              {feedback.text}
            </Text>
          )}

          {preflightFailure?.kind === 'retryable' && (
            <Button
              accessibilityLabel={t('kiloPass.tryVerifyingPurchaseAgain')}
              className="self-start"
              onPress={() => {
                void runPreflight(preflightFailure.product);
              }}
              variant="outline"
            >
              <Text>{t('common.tryAgain')}</Text>
            </Button>
          )}

          {productsIsLoading &&
            [0, 1, 2].map(index => (
              <Skeleton key={index} className="h-[112px] w-full rounded-xl" />
            ))}

          {!productsIsLoading && products.length === 0 && (
            <Pressable
              accessibilityLabel={t('kiloPass.tryLoadingProductsAgain')}
              accessibilityRole="button"
              accessibilityState={{
                busy: productsIsRefetching,
                disabled: isRetryDisabled,
              }}
              className="rounded-xl border border-border bg-card p-5 active:opacity-80"
              disabled={isRetryDisabled}
              onPress={() => {
                void productsRefetch();
              }}
            >
              <Text className="font-semibold text-foreground">
                {t('kiloPass.productsUnavailable')}
              </Text>
              <Text className="mt-1 text-sm text-muted-foreground">
                {productsError ?? t('kiloPass.productsCouldNotLoad')}
              </Text>
              <Text className="mt-3 text-sm font-medium text-primary">
                {productsIsRefetching ? t('kiloPass.tryingAgain') : t('common.tryAgain')}
              </Text>
            </Pressable>
          )}

          {!productsIsLoading &&
            products.map(product => (
              <Pressable
                key={product.appleProductId}
                accessibilityLabel={t('kiloPass.productAccessibility', {
                  tier: formatTier(product),
                  price: formatStorePrice(product),
                })}
                accessibilityRole="button"
                accessibilityState={{
                  busy: isPending || preflightPurchase.isPending,
                  disabled: tilesDisabled,
                }}
                className={cn(
                  'rounded-xl border border-border bg-card p-5 active:opacity-80',
                  tilesDisabled && 'opacity-50'
                )}
                disabled={tilesDisabled}
                onPress={() => {
                  handleProductPress(product);
                }}
              >
                <View className="flex-row items-start justify-between gap-4">
                  <View className="flex-1 gap-1.5">
                    <Text className="font-semibold text-foreground">{formatTier(product)}</Text>
                    <Text className="text-xs text-muted-foreground">
                      {t('kiloPass.tierDescription', { price: product.webMonthlyPriceUsd })}
                    </Text>
                  </View>
                  <Text className="text-base font-semibold text-foreground tabular-nums">
                    {formatStorePrice(product)}
                  </Text>
                </View>
              </Pressable>
            ))}

          <RestorePurchasesButton
            onResult={result => {
              if (result === 'restored') {
                setRestoreFeedback({ type: 'success', text: t('kiloPass.subscriptionRestored') });
                ensureProfileAfterKiloPassPurchase(router);
              } else if (result === 'empty') {
                setRestoreFeedback({ type: 'info', text: t('kiloPass.noPurchasesToRestore') });
              } else {
                setRestoreFeedback(null);
              }
            }}
          />

          <Text className="px-1 pt-1 text-xs leading-5 text-muted-foreground">
            {KILO_PASS_LEGAL_DISCLOSURE}
            {t('kiloPass.legalConnectorTerms')}
            <Text
              accessibilityRole="link"
              className="text-xs text-primary underline active:opacity-70"
              onPress={() => {
                void openExternalUrl(termsOfUseLink.url, { label: termsOfUseLink.label });
              }}
            >
              {termsOfUseLink.label}
            </Text>
            {t('kiloPass.legalConnectorPrivacy')}
            <Text
              accessibilityRole="link"
              className="text-xs text-primary underline active:opacity-70"
              onPress={() => {
                void openExternalUrl(privacyPolicyLink.url, { label: privacyPolicyLink.label });
              }}
            >
              {privacyPolicyLink.label}
            </Text>
            .
          </Text>
        </DetailScreenScrollView>

        {isPending && (
          <View style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
            <Button
              accessibilityLabel={t('kiloPass.completingPurchaseAccessibility')}
              accessibilityState={{ busy: true, disabled: true }}
              className="mt-4"
              disabled
            >
              <ActivityIndicator size="small" color={colors.primaryForeground} />
              <Text>{t('kiloPass.completingPurchase')}</Text>
            </Button>
          </View>
        )}
      </View>
    </View>
  );
}

export function KiloPassSubscriptionScreen() {
  const trpc = useTRPC();
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  const storefront = Platform.OS === 'ios' ? 'app_store' : 'play';
  const presentationQuery = useQuery(
    trpc.kiloPass.getPurchasePresentation.queryOptions({
      platform,
      storefront,
      product: 'kilo_pass',
    })
  );

  if (presentationQuery.isPending) {
    return <KiloPassLoadingScreen />;
  }

  if (presentationQuery.isError) {
    return (
      <KiloPassPresentationErrorScreen
        onRetry={() => {
          void presentationQuery.refetch();
        }}
      />
    );
  }

  const presentation = presentationQuery.data;
  if (presentation.kind !== 'native_iap' || Platform.OS !== 'ios') {
    return <KiloPassUnavailableScreen presentation={presentation} />;
  }

  return (
    <KiloPassNativeIapOwner>
      <KiloPassNativeIapContent />
    </KiloPassNativeIapOwner>
  );
}
