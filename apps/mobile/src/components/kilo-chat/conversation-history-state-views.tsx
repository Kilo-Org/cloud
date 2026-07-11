import { Pressable, View } from 'react-native';

import { QueryError } from '@/components/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { AppAwareKeyboardPaddingView } from './app-aware-keyboard-padding';
import { ConversationHeader } from './conversation-header';

type Props = {
  subtitle?: string;
  title?: string;
};

export function ConversationHistoryLoadingView({ subtitle, title }: Props) {
  return (
    <View className="flex-1">
      <ConversationHeader title={title} subtitle={subtitle} />
      <AppAwareKeyboardPaddingView className="flex-1">
        <View className="flex-1 justify-end gap-3 px-4 py-6">
          <Skeleton className="h-14 w-3/4 rounded-2xl" />
          <Skeleton className="ml-auto h-16 w-2/3 rounded-2xl" />
          <Skeleton className="h-20 w-5/6 rounded-2xl" />
        </View>
      </AppAwareKeyboardPaddingView>
    </View>
  );
}

export function ConversationHistoryErrorView({
  message = 'Could not load conversation history',
  onRetry,
  subtitle,
  title,
}: Props & {
  message?: string;
  onRetry: () => void;
}) {
  return (
    <View className="flex-1">
      <ConversationHeader title={title} subtitle={subtitle} />
      <AppAwareKeyboardPaddingView className="flex-1">
        <QueryError className="flex-1" message={message} onRetry={onRetry} />
      </AppAwareKeyboardPaddingView>
    </View>
  );
}

/** Slim inline banner for a background/refetch failure while stale data is still shown. */
export function ConversationInlineRetryBanner({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <View className="flex-row items-center justify-between gap-2 border-b border-neutral-200 bg-neutral-100 px-4 py-2 dark:border-neutral-800 dark:bg-neutral-900">
      <Text variant="muted" className="flex-1 text-xs">
        {message}
      </Text>
      <Pressable
        onPress={onRetry}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Retry"
        className="active:opacity-70"
      >
        <Text className="text-xs font-medium text-foreground">Retry</Text>
      </Pressable>
    </View>
  );
}
