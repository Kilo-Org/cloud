import { FlatList, Modal, View } from 'react-native';
import { type StoredMessage } from 'cloud-agent-sdk';

import { SheetHeader } from '@/components/sheet-header';
import { Text } from '@/components/ui/text';

import {
  ChildSessionMessage,
  type OpenChildSession,
  type RenderPartFn,
} from './child-session-section';
import { MessageErrorBoundary } from './message-error-boundary';

type ChildSessionSheetProps = {
  sessionId: string;
  title: string;
  getChildMessages: (sessionId: string) => StoredMessage[];
  renderPart: RenderPartFn;
  onOpenChildSession: OpenChildSession;
  onClose: () => void;
};

export function ChildSessionSheet({
  sessionId,
  title,
  getChildMessages,
  renderPart,
  onOpenChildSession,
  onClose,
}: Readonly<ChildSessionSheetProps>) {
  const messages = getChildMessages(sessionId);

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View className="flex-1 bg-background">
        <SheetHeader title={title} onDone={onClose} />
        {messages.length > 0 ? (
          <FlatList
            data={messages}
            keyExtractor={message => message.info.id}
            renderItem={({ item }) => (
              <MessageErrorBoundary>
                <View className="px-4 py-1">
                  <ChildSessionMessage
                    message={item}
                    depth={0}
                    getChildMessages={getChildMessages}
                    renderPart={renderPart}
                    onOpenChildSession={onOpenChildSession}
                  />
                </View>
              </MessageErrorBoundary>
            )}
            contentContainerClassName="py-2"
          />
        ) : (
          <View className="flex-1 items-center justify-center px-6">
            <Text className="text-center text-sm text-muted-foreground">
              Waiting for subagent messages…
            </Text>
          </View>
        )}
      </View>
    </Modal>
  );
}
