import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { PickerSheet } from '@/components/picker-sheet';
import { QueryError } from '@/components/query-error';
import { ActivityIndicator } from '@/components/ui/activity-indicator';

/**
 * The list settings formSheet's stand-in while the saved list is still loading,
 * and its error state when the lists query fails.
 */
export function ListSettingsPendingSheet({
  isError,
  isFetching,
  isSuccess,
  onRetry,
  onDone,
}: Readonly<{
  isError: boolean;
  isFetching: boolean;
  isSuccess: boolean;
  onRetry: () => void;
  onDone: () => void;
}>) {
  const { t } = useTranslation();
  return (
    <PickerSheet
      title={t('todos.listSettings.title')}
      onDone={onDone}
      scrollable={false}
      expired={isSuccess}
    >
      {isError ? (
        <QueryError onRetry={onRetry} isRetrying={isFetching} placement="top" />
      ) : (
        <View className="items-center py-8">
          <ActivityIndicator />
        </View>
      )}
    </PickerSheet>
  );
}
