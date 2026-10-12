import { type Href, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { type ReactNode } from 'react';
import { Linking, Platform, Pressable, useWindowDimensions, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';

import { Text } from '@/components/ui/text';
import { KiloPassIcon } from '@/components/kilo-pass/kilo-pass-icon';
import { Skeleton } from '@/components/ui/skeleton';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { isNarrowLayout } from '@/lib/narrow-layout';
import { useTRPC } from '@/lib/trpc';
import {
  getKiloPassSubscriptionCardAccessibility,
  getKiloPassSubscriptionCardContentState,
} from '@/lib/kilo-pass/subscription-card-state';

export function KiloPassSubscriptionCard({
  hideLoadingSkeleton = false,
}: Readonly<{
  /**
   * Render no loading shimmer while the card's queries are still in flight:
   * the credits section already shows its one loading indicator (the balance
   * skeleton), and stacking a second skeleton card reads as two loaders at
   * once. The slot keeps the card's final height so the swap in and out of
   * this state never moves the sections below.
   */
  hideLoadingSkeleton?: boolean;
}>) {
  const colors = useThemeColors();
  const router = useRouter();
  const trpc = useTRPC();
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  // In a narrow window the fixed icon tile plus the fixed trailing label are
  // wider than the card, so the flexible text block collapses to zero width
  // and the wrapped copy stretches the card into an empty slab (Profile,
  // 160 dp, e1 round, 2026-09-21). Stacking hands the text the card's full
  // width, the same presentation ConfigureRow takes on these screens.
  const narrow = isNarrowLayout(width);
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  const storefront = Platform.OS === 'ios' ? 'app_store' : 'play';
  const presentationQuery = useQuery(
    trpc.kiloPass.getPurchasePresentation.queryOptions({
      platform,
      storefront,
      product: 'kilo_pass',
    })
  );
  const contentState = getKiloPassSubscriptionCardContentState({
    presentation: presentationQuery.data,
    presentationIsError: presentationQuery.isError,
    presentationIsPending: presentationQuery.isPending,
  });

  const handlePress = () => {
    if (contentState.kind !== 'card') {
      return;
    }

    const cardState = contentState.state;

    void Haptics.selectionAsync();
    if (cardState.action === 'open-web') {
      const webUrl = presentationQuery.data?.webUrl;
      if (webUrl) {
        void Linking.openURL(webUrl);
      }
      return;
    }
    router.push('/(app)/kilo-pass' as Href);
  };
  const handleRetryPress = () => {
    void Haptics.selectionAsync();
    void presentationQuery.refetch();
  };

  const isUnavailable = presentationQuery.data?.kind === 'unavailable';

  // The card body's one row: icon tile + text block + an optional trailing
  // label, stacked when a narrow window cannot fit the fixed siblings.
  const iconTile = (
    <View className="h-10 w-10 shrink-0 items-center justify-center rounded-md bg-secondary">
      <KiloPassIcon size={19} color={colors.primary} />
    </View>
  );
  const cardBody = (text: ReactNode, trailing?: ReactNode, tile: ReactNode = iconTile) =>
    narrow ? (
      <View className="gap-2">
        <View className="flex-row items-center justify-between gap-3">
          {tile}
          {trailing ?? null}
        </View>
        <View className="w-full">{text}</View>
      </View>
    ) : (
      <View className="flex-row items-center gap-3">
        {tile}
        <View className="flex-1">{text}</View>
        {trailing ?? null}
      </View>
    );

  return (
    <View className="gap-2">
      {contentState.kind === 'loading' && hideLoadingSkeleton ? (
        // The height the loading card below renders at, so revealing it never
        // moves layout: p-3 (24) + the h-10 icon row (40) + the 1px borders
        // (2), plus the stacked copy row (gap-2 8 + the two skeleton bars
        // 12 + 16 + 12) when narrow.
        <View className={narrow ? 'h-[114px]' : 'h-[66px]'} />
      ) : null}

      {contentState.kind === 'loading' && !hideLoadingSkeleton ? (
        <View
          accessibilityLabel={t('kiloPass.subscriptionLoading')}
          accessibilityState={{ busy: true }}
          className="rounded-lg border border-border bg-card p-3"
        >
          {cardBody(
            // Bars the height of the loaded title and description lines, clamped
            // so a narrow window cannot overflow the card.
            <View className="gap-3">
              <Skeleton className="h-4 w-28 max-w-full rounded" />
              <Skeleton className="h-3 w-48 max-w-full rounded" />
            </View>,
            undefined,
            <Skeleton className="h-10 w-10 rounded-md" />
          )}
        </View>
      ) : null}

      {contentState.kind === 'error' ? (
        <Pressable
          accessibilityHint={t('kiloPass.retryHint')}
          accessibilityLabel={t('kiloPass.cardAccessibility', {
            title: contentState.title,
            description: contentState.description,
            actionLabel: contentState.actionLabel,
          })}
          accessibilityRole="button"
          className="rounded-lg border border-border bg-card p-3 active:opacity-80"
          onPress={handleRetryPress}
        >
          {cardBody(
            <>
              <Text className="font-semibold">{contentState.title}</Text>
              <Text className="text-xs text-muted-foreground">{contentState.description}</Text>
            </>,
            <Text className="shrink-0 text-xs font-medium text-primary">
              {contentState.actionLabel}
            </Text>
          )}
        </Pressable>
      ) : null}

      {contentState.kind === 'card' ? (
        <Pressable
          accessibilityHint={
            getKiloPassSubscriptionCardAccessibility(contentState.state).accessibilityHint
          }
          accessibilityLabel={
            getKiloPassSubscriptionCardAccessibility(contentState.state).accessibilityLabel
          }
          accessibilityRole="button"
          className="rounded-lg border border-border bg-card p-3 active:opacity-80"
          onPress={handlePress}
          testID={isUnavailable ? 'kilo-pass-unavailable-card' : undefined}
        >
          {cardBody(
            <>
              <Text className="font-semibold">{contentState.state.title}</Text>
              <Text className="text-xs text-muted-foreground">
                {contentState.state.description}
              </Text>
            </>,
            contentState.state.actionLabel ? (
              <Text className="shrink-0 text-xs font-medium text-primary">
                {contentState.state.actionLabel}
              </Text>
            ) : undefined
          )}
        </Pressable>
      ) : null}
    </View>
  );
}
