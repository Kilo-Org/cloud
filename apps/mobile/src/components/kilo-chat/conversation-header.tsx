import { ActivityIndicator, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';

import { useConversationDetail } from './hooks/use-conversations';

type ConversationHeaderProps = {
  conversationId: string;
};

export function ConversationHeader({ conversationId }: Readonly<ConversationHeaderProps>) {
  const { data, isLoading } = useConversationDetail(conversationId);
  const title = data?.title ?? 'Conversation';

  return (
    <ScreenHeader
      title={title}
      headerRight={
        isLoading ? (
          <View className="pr-1">
            <ActivityIndicator size="small" />
          </View>
        ) : undefined
      }
    />
  );
}
