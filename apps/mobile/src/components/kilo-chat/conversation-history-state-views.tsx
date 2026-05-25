import { View } from 'react-native';

import { QueryError } from '@/components/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { AppAwareKeyboardPaddingView } from './app-aware-keyboard-padding';
import { ConversationHeader } from './conversation-header';

type Props = {
  subtitle: string;
  title: string;
};

export function ConversationHistoryLoadingView({ subtitle, title }: Props) {
  return (
    <View className="flex-1">
      <ConversationHeader title={title} subtitle={subtitle} />
      <AppAwareKeyboardPaddingView className="flex-1">
        <View className="flex-1 justify-end gap-3 px-4 py-6">
          <Skeleton className="h-14 w-3/4 rounded-md" />
          <Skeleton className="ml-auto h-16 w-2/3 rounded-md" />
          <Skeleton className="h-20 w-5/6 rounded-md" />
        </View>
      </AppAwareKeyboardPaddingView>
    </View>
  );
}

export function ConversationHistoryErrorView({
  onRetry,
  subtitle,
  title,
}: Props & {
  onRetry: () => void;
}) {
  return (
    <View className="flex-1">
      <ConversationHeader title={title} subtitle={subtitle} />
      <AppAwareKeyboardPaddingView className="flex-1">
        <QueryError
          className="flex-1"
          message="Could not load conversation history"
          onRetry={onRetry}
        />
      </AppAwareKeyboardPaddingView>
    </View>
  );
}
