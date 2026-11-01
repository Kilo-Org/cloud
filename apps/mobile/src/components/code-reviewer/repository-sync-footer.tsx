import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
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
          // The compact box keeps its 44dp touch area through the button's own
          // hit slop and the minimum width, so a short label in another language
          // cannot shrink it below the target; the vertical margins cancel the
          // height it would otherwise add, so this line sits the same 8dp under
          // the count as the count sits under the explanation.
          className="-my-[11px] min-w-[36px] px-0"
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
