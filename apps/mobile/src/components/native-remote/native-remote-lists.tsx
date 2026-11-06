import { type NativeSessionState, type NativeSessionSummary } from '@kilocode/cloud-agent-sdk';
import { FlashList } from '@shopify/flash-list';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { transcriptText } from '@/lib/native-remote/projections';

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

export function NativeRemoteMessages({ messages }: { messages: NativeSessionState['messages'] }) {
  const { t } = useTranslation();
  if (messages.length === 0) {
    return <Text className="text-muted-foreground">{t('agentChat.session.emptyTitle')}</Text>;
  }
  return (
    <View className="h-80 flex-none">
      <FlashList
        data={messages}
        keyExtractor={message => message.id}
        nestedScrollEnabled
        renderItem={({ item }) => (
          <View className="mb-2 gap-1 rounded-md bg-secondary p-3">
            <Text className="text-xs text-muted-foreground">
              {item.role}
              {item.incomplete ? ' …' : ''}
            </Text>
            <Text selectable>{transcriptText(item.content)}</Text>
          </View>
        )}
      />
    </View>
  );
}
