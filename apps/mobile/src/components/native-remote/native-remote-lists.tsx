import { type NativeSessionSummary, type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { FlashList } from '@shopify/flash-list';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { MessageBubble } from '@/components/agents/message-bubble';
import { PartDetailSheetHost } from '@/components/agents/part-detail-sheet-host';

export function NativeRemoteSessionList({
  sessions,
  select,
}: {
  sessions: NativeSessionSummary[];
  select: (session: NativeSessionSummary) => void;
}) {
  const { t } = useTranslation();
  return (
    <View className="h-64 flex-none">
      <FlashList
        data={sessions}
        keyExtractor={session => session.sessionID}
        nestedScrollEnabled
        renderItem={({ item }) => (
          <Button
            variant="outline"
            className="mb-2 justify-start"
            onPress={() => {
              select(item);
            }}
          >
            <Text className="min-w-0 flex-1" numberOfLines={2}>
              {item.live ? t('common.online') : t('chat.botStatus.offline')} · {item.sessionID}
            </Text>
          </Button>
        )}
      />
    </View>
  );
}

export function NativeRemoteMessages({ messages }: { messages: StoredMessage[] }) {
  const { t } = useTranslation();
  if (messages.length === 0) {
    return <Text className="text-muted-foreground">{t('agentChat.session.emptyTitle')}</Text>;
  }
  return (
    <PartDetailSheetHost messages={messages}>
      <View className="h-80 flex-none">
        <FlashList
          data={messages}
          keyExtractor={message => message.info.id}
          nestedScrollEnabled
          renderItem={({ item }) => (
            <MessageBubble
              message={item}
              isSessionStreaming={
                item.info.role === 'assistant' && item.info.time.completed === undefined
              }
              isLastAssistantMessage={
                item.info.role === 'assistant' && item.info.time.completed === undefined
              }
              retryAvailable={false}
            />
          )}
        />
      </View>
    </PartDetailSheetHost>
  );
}
