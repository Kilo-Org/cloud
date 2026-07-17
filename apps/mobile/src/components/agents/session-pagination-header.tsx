import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
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

  if (model.kind === 'loading') {
    return (
      <View
        testID={model.testID}
        className="items-start gap-1 px-4 py-2"
        accessibilityRole={model.accessibilityRole}
      >
        <Skeleton className="h-16 w-3/4 rounded-2xl rounded-tl-sm" />
      </View>
    );
  }

  if (model.kind === 'retryable') {
    return (
      <View
        testID={model.testID}
        className="flex-row items-center justify-between gap-3 px-4 py-2"
        accessibilityLiveRegion="polite"
      >
        <Text className="flex-1 text-sm text-muted-foreground">{model.text}</Text>
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
    <View testID={model.testID} className="px-4 py-2" accessibilityLiveRegion="polite">
      <Text className="text-sm text-muted-foreground">{model.text}</Text>
    </View>
  );
}
