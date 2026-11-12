import { type Href, useRouter } from 'expo-router';
import { selectionHaptic } from '@/lib/haptics';
import { type ReactNode } from 'react';
import { Pressable, useWindowDimensions, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';

import { ChevronRight } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { KiloPassIcon } from '@/components/kilo-pass/kilo-pass-icon';
import { Skeleton } from '@/components/ui/skeleton';
import { rowTint } from '@/lib/agent-color';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getKiloPassCardContentState } from '@/lib/kilo-pass/state';
import { isNarrowLayout } from '@/lib/narrow-layout';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/lib/trpc';

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
  const stateQuery = useQuery(trpc.kiloPass.getState.queryOptions());
  const contentState = getKiloPassCardContentState({
    subscription: stateQuery.data?.subscription,
    isError: stateQuery.isError,
    isPending: stateQuery.isPending,
  });

  const handlePress = () => {
    if (contentState.kind !== 'card') {
      return;
    }
    selectionHaptic();
    router.push('/(app)/kilo-pass' as Href);
  };
  const handleRetryPress = () => {
    selectionHaptic();
    void stateQuery.refetch();
  };

  // The card body's one row: icon tile + text block + an optional trailing
  // label, stacked when a narrow window cannot fit the fixed siblings.
  const iconTile = (
    <View className="h-10 w-10 shrink-0 items-center justify-center rounded-md bg-secondary">
      <KiloPassIcon size={19} color={colors[rowTint('honey').hueThemeKey]} />
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
        // moves layout. The card's rem is 14 pt, not 16, so the wide row
        // measures p-3 (21) + the h-10 icon row (35) + the 1px borders (2):
        // 58 dp, which the design gate measured as 58.67 dp loaded on Profile
        // (2026-11-05). The earlier 66 assumed a 16 pt rem and left every
        // section below the card moving 8 dp when the card arrived.
        //
        // The stacked reserve holds the tallest state: p-3 (21) + borders (2)
        // + the h-10 icon row (35) + the gap (7) + the title (21) and the two
        // lines the no-pass and ended sentences wrap to at a narrow width (28).
        <View className={narrow ? 'h-[114px]' : 'h-[58px]'} />
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
              <Text className="font-semibold" numberOfLines={1}>
                {contentState.title}
              </Text>
              {/* The stacked card keeps a two-line slot at every state so the
                  reserved loading height is the height the card resolves to;
                  the side-by-side layout clamps the line instead. */}
              <Text
                className={cn('text-xs text-muted-foreground', narrow && 'min-h-[28px]')}
                numberOfLines={narrow ? 2 : 1}
              >
                {contentState.description}
              </Text>
            </>,
            <Text className="shrink-0 text-xs font-medium text-primary">
              {contentState.actionLabel}
            </Text>
          )}
        </Pressable>
      ) : null}

      {contentState.kind === 'card' ? (
        <Pressable
          accessibilityLabel={contentState.accessibilityLabel}
          accessibilityRole="button"
          className="rounded-lg border border-border bg-card p-3 active:opacity-80"
          onPress={handlePress}
        >
          {cardBody(
            <>
              <Text className="font-semibold" numberOfLines={1}>
                {contentState.title}
              </Text>
              {/* The stacked card keeps a two-line slot at every state so the
                  reserved loading height is the height the card resolves to;
                  the side-by-side layout clamps the line instead. */}
              <Text
                className={cn('text-xs text-muted-foreground', narrow && 'min-h-[28px]')}
                numberOfLines={narrow ? 2 : 1}
              >
                {contentState.description}
              </Text>
            </>,
            <ChevronRight size={16} color={colors.mutedForeground} className="shrink-0" />
          )}
        </Pressable>
      ) : null}
    </View>
  );
}
