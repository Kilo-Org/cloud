import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { LINE_ACTION_BOX_CLASS, LINE_ACTION_HIT_SLOP } from '@/lib/a11y/tap-target';
import { type ManageRepositoryAccess } from '@/lib/hooks/use-manage-repository-access';
import { cn } from '@/lib/utils';

/**
 * What a non-empty repository list offers below its rows: how old the shown
 * snapshot is with the re-read that renews it, and — where the provider has
 * such a page — the settings page that widens the integration's access.
 *
 * The re-read is a text action on the sync line it renews, not a second
 * full-width control: refresh and last-synced answer the same question, and
 * two identical outlined buttons left neither of them reading as the action
 * worth taking. The page that widens access is the primary action and stands a
 * section away from the sync line. A short or stale list is exactly the state
 * where these matter, so they cannot live in the empty state alone.
 */
export function RepositorySyncFooter({
  syncedLabel,
  refreshing,
  onRefresh,
  manageAccess,
  className,
}: Readonly<{
  syncedLabel: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  manageAccess?: ManageRepositoryAccess | undefined;
  /** The top gap of the block, which follows a list or a status line. */
  className?: string | undefined;
}>) {
  const { t } = useTranslation();
  return (
    <View className={cn('gap-6', className)}>
      <View
        className={cn(
          'flex-row items-center gap-3',
          syncedLabel ? 'justify-between' : 'justify-end'
        )}
      >
        {syncedLabel && (
          <Text variant="muted" className="shrink text-xs">
            {syncedLabel}
          </Text>
        )}
        <Button
          variant="link"
          size="sm"
          // The line's action keeps a 28dp box instead of `sm`'s 36dp frame: its
          // layout height is cancelled so the line keeps the 7dp rhythm it has
          // under the count, and a 36dp frame would then reach past that gap
          // into the count itself. The 44dp reach comes from the box plus its
          // slop, and the minimum width keeps a short label from shrinking the
          // target in another language.
          className={cn(LINE_ACTION_BOX_CLASS, 'min-w-[36px] px-0')}
          hitSlop={LINE_ACTION_HIT_SLOP}
          loading={refreshing}
          disabled={refreshing}
          onPress={onRefresh}
        >
          <Text>{t('common.refresh')}</Text>
        </Button>
      </View>
      {manageAccess && (
        <Button
          loading={manageAccess.pending}
          disabled={manageAccess.pending}
          onPress={manageAccess.handlePress}
        >
          <Text>{t('codeReviewer.repos.manageAccess')}</Text>
        </Button>
      )}
    </View>
  );
}
