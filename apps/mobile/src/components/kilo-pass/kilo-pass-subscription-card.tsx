import { type Href, useRouter } from 'expo-router';
import { selectionHaptic } from '@/lib/haptics';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Pressable, useWindowDimensions, View } from 'react-native';

import { ConfigureRow } from '@/components/ui/configure-row';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Text } from '@/components/ui/text';
import { KiloPassIcon } from '@/components/kilo-pass/kilo-pass-icon';
import { useLiveFontScale } from '@/lib/font-scale/system-font-scale-context';
import { getKiloPassCardContentState } from '@/lib/kilo-pass/state';
import { isNarrowLayout } from '@/lib/narrow-layout';
import { useTRPC } from '@/lib/trpc';
import { cn } from '@/lib/utils';

/**
 * The scale at which `ConfigureRow` stacks its tile above the copy, shared with
 * the loading row here so the reservation and the row it stands in for take the
 * same shape. `configure-row.tsx` keeps the number itself.
 */
const CONFIGURE_ROW_STACK_FONT_SCALE = 1.8;

export function KiloPassSubscriptionCard({
  hideLoadingSkeleton = false,
}: Readonly<{
  /**
   * Render no loading shimmer while the card's queries are still in flight:
   * the credits section already shows its one loading indicator (the balance
   * skeleton). The row's own shape stays in the flow, invisible, so the card
   * revealing itself never moves the sections below.
   */
  hideLoadingSkeleton?: boolean;
}>) {
  const router = useRouter();
  const trpc = useTRPC();
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const fontScale = useLiveFontScale();
  // The same presentation `ConfigureRow` picks: a narrow window or a large
  // Dynamic Type scale hands the copy the row's full width, so the loading row
  // and the description's line cap follow it.
  const stack = fontScale >= CONFIGURE_ROW_STACK_FONT_SCALE || isNarrowLayout(width);
  const stateQuery = useQuery(trpc.kiloPass.getState.queryOptions());
  const contentState = getKiloPassCardContentState({
    subscription: stateQuery.data?.subscription,
    isError: stateQuery.isError,
    isPending: stateQuery.isPending,
  });

  const handlePress = () => {
    selectionHaptic();
    router.push('/(app)/kilo-pass' as Href);
  };
  const handleRetryPress = () => {
    selectionHaptic();
    void stateQuery.refetch();
  };

  return (
    <>
      {/* The loading row is the row the loaded card renders, so revealing it
          never moves the sections below. A caller that already shows the
          section's one loading indicator keeps the row's space only. */}
      {contentState.kind === 'loading' ? (
        <View
          accessibilityLabel={hideLoadingSkeleton ? undefined : t('kiloPass.subscriptionLoading')}
          accessibilityState={hideLoadingSkeleton ? undefined : { busy: true }}
          accessibilityElementsHidden={hideLoadingSkeleton}
          importantForAccessibility={hideLoadingSkeleton ? 'no-hide-descendants' : undefined}
          className={cn(hideLoadingSkeleton && 'opacity-0')}
        >
          <RowGroup>
            <RowSkeleton stack={stack} tile subtitle />
          </RowGroup>
        </View>
      ) : null}

      {contentState.kind === 'error' ? (
        <RowGroup leadingTile>
          {/* The retry row is its own pressable: `ConfigureRow` carries the
              row's anatomy, and the hint names the command the row runs, which
              the shared row's label-only API cannot express. */}
          <Pressable
            accessibilityHint={t('kiloPass.retryHint')}
            accessibilityLabel={contentState.accessibilityLabel}
            accessibilityRole="button"
            className="active:opacity-70"
            onPress={handleRetryPress}
          >
            <ConfigureRow
              icon={KiloPassIcon}
              title={contentState.title}
              subtitle={contentState.description}
              // The row's height is its capped copy: a stacked row has the full
              // width for two lines, the side-by-side one holds a single line.
              subtitleNumberOfLines={stack ? 2 : 1}
              variant="action"
              trailing={
                <Text variant="small" className="text-primary">
                  {contentState.actionLabel}
                </Text>
              }
            />
          </Pressable>
        </RowGroup>
      ) : null}

      {contentState.kind === 'card' ? (
        <RowGroup leadingTile>
          <ConfigureRow
            icon={KiloPassIcon}
            title={contentState.title}
            subtitle={contentState.description}
            subtitleNumberOfLines={stack ? 2 : 1}
            hue="honey"
            accessibilityLabel={contentState.accessibilityLabel}
            onPress={handlePress}
          />
        </RowGroup>
      ) : null}
    </>
  );
}
