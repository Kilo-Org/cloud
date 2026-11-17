import { type Href, useRouter } from 'expo-router';
import { selectionHaptic } from '@/lib/haptics';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';

import { ConfigureRow } from '@/components/ui/configure-row';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { type LucideIcon } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { KiloPassIcon } from '@/components/kilo-pass/kilo-pass-icon';
import { getKiloPassCardContentState } from '@/lib/kilo-pass/state';
import { useTRPC } from '@/lib/trpc';

// The wrapper forwards the crown's props, but a plain function does not carry
// the forward-ref brand `LucideIcon` names; the row only needs the icon value.
const ROW_ICON = KiloPassIcon as unknown as LucideIcon;

export function KiloPassSubscriptionCard({
  hideLoadingSkeleton = false,
}: Readonly<{
  /**
   * Render no loading shimmer while the card's queries are still in flight:
   * the caller keeps the row's space itself.
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
          never moves the sections below. */}
      {contentState.kind === 'loading' && !hideLoadingSkeleton ? (
        <RowGroup>
          <RowSkeleton tile subtitle />
        </RowGroup>
      ) : null}

      {contentState.kind === 'error' ? (
        <RowGroup leadingTile>
          <ConfigureRow
            icon={ROW_ICON}
            title={contentState.title}
            subtitle={contentState.description}
            accessibilityLabel={t('kiloPass.cardAccessibility', {
              title: contentState.title,
              description: contentState.description,
              actionLabel: contentState.actionLabel,
            })}
            variant="action"
            trailing={
              <Text variant="small" className="text-primary">
                {contentState.actionLabel}
              </Text>
            }
            onPress={handleRetryPress}
          />
        </RowGroup>
      ) : null}

      {contentState.kind === 'card' ? (
        <RowGroup leadingTile>
          <ConfigureRow
            icon={ROW_ICON}
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
