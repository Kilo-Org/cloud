import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import {
  selectSessionPaginationHeaderRenderModel,
  type SessionPaginationHeaderRenderModel,
} from '@/components/agents/session-pagination-header-render-model';

type SessionPaginationHeaderProps = {
  isLoadingOlderMessages: boolean;
  olderMessagesError: Parameters<
    typeof selectSessionPaginationHeaderRenderModel
  >[0]['olderMessagesError'];
  olderMessagesOmittedItemCount: number;
  onRetry: () => void;
};

export function SessionPaginationHeader({
  isLoadingOlderMessages,
  olderMessagesError,
  olderMessagesOmittedItemCount,
  onRetry,
}: Readonly<SessionPaginationHeaderProps>) {
  const model: SessionPaginationHeaderRenderModel = selectSessionPaginationHeaderRenderModel({
    isLoadingOlderMessages,
    olderMessagesError,
    olderMessagesOmittedItemCount,
  });

  if (model.kind === 'hidden') {
    return null;
  }

  if (model.kind === 'retryable') {
    return (
      <View testID={model.testID} className="flex-row items-center justify-between gap-3 px-4 py-2">
        <AccessibleStatus message={model.text} tone="status" className="flex-1 text-sm" />
        <Button
          variant="outline"
          size="sm"
          onPress={onRetry}
          // h-11 is 44pt on iOS, exceeding the >=44pt touch target.
          className="min-h-11"
          accessibilityLabel={model.retry.label}
          accessibilityHint={model.retry.accessibilityHint}
        >
          <Text>{model.retry.label}</Text>
        </Button>
      </View>
    );
  }

  return (
    <View testID={model.testID} className="px-4 py-2">
      <AccessibleStatus message={model.text} tone="status" className="text-sm" />
    </View>
  );
}
