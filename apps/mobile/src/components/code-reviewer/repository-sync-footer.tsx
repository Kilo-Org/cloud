import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/**
 * What a non-empty repository list offers below its rows: how old the shown
 * snapshot is, one control that re-reads the provider list, and — where the
 * provider has such a page — the settings page that widens the integration's
 * access. A short or stale list is exactly the state where these matter, so
 * they cannot live in the empty state alone.
 */
export function RepositorySyncFooter({
  syncedLabel,
  refreshing,
  onRefresh,
  manageAccess,
}: Readonly<{
  syncedLabel: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  manageAccess?: (() => void) | undefined;
}>) {
  const { t } = useTranslation();
  return (
    <View className="mt-6 gap-3">
      {syncedLabel && (
        <Text variant="muted" className="text-xs">
          {syncedLabel}
        </Text>
      )}
      <Button variant="outline" loading={refreshing} disabled={refreshing} onPress={onRefresh}>
        <Text>{t('common.refresh')}</Text>
      </Button>
      {manageAccess && (
        <Button variant="outline" onPress={manageAccess}>
          <Text>{t('codeReviewer.repos.manageAccess')}</Text>
        </Button>
      )}
    </View>
  );
}
