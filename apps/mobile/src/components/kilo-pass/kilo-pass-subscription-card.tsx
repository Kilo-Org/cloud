import { type Href, useRouter } from 'expo-router';
import { selectionHaptic } from '@/lib/haptics';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Pressable, View } from 'react-native';

import { ConfigureRow } from '@/components/ui/configure-row';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Text } from '@/components/ui/text';
import { KiloPassIcon } from '@/components/kilo-pass/kilo-pass-icon';
import { getKiloPassCardContentState } from '@/lib/kilo-pass/state';
import { useTRPC } from '@/lib/trpc';
import { cn } from '@/lib/utils';

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
            <RowSkeleton tile subtitle />
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
            accessibilityLabel={t('kiloPass.cardAccessibility', {
              title: contentState.title,
              description: contentState.description,
              actionLabel: contentState.actionLabel,
            })}
            accessibilityRole="button"
            className="active:opacity-70"
            onPress={handleRetryPress}
          >
            <ConfigureRow
              icon={KiloPassIcon}
              title={contentState.title}
              subtitle={contentState.description}
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
            hue="honey"
            accessibilityLabel={contentState.accessibilityLabel}
            onPress={handlePress}
          />
        </RowGroup>
      ) : null}
    </>
  );
}
