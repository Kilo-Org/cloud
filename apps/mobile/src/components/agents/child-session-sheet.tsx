import { type ReactNode } from 'react';
import { FlatList, Modal, View } from 'react-native';
import { type ChildSessionHydrationState, type StoredMessage } from 'cloud-agent-sdk';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { SheetHeader } from '@/components/sheet-header';
import { Bot } from 'lucide-react-native';

import {
  ChildSessionMessage,
  type OpenChildSession,
  type RenderPartFn,
} from './child-session-section';
import { MessageErrorBoundary } from './message-error-boundary';
import { getChildSessionSheetState } from './child-session-sheet-state';

type ChildSessionSheetProps = {
  sessionId: string;
  title: string;
  getChildMessages: (sessionId: string) => StoredMessage[];
  hydrationState: ChildSessionHydrationState;
  renderPart: RenderPartFn;
  onOpenChildSession: OpenChildSession;
  onRetry: () => void;
  onClose: () => void;
};

export function ChildSessionSheet({
  sessionId,
  title,
  getChildMessages,
  hydrationState,
  renderPart,
  onOpenChildSession,
  onRetry,
  onClose,
}: Readonly<ChildSessionSheetProps>) {
  const messages = getChildMessages(sessionId);
  const state = getChildSessionSheetState(hydrationState, messages.length);
  let content: ReactNode = null;

  if (state === 'content') {
    content = (
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
    );
  } else if (state === 'error') {
    content = (
      <QueryError
        title="Could not load subagent session"
        message={hydrationState.status === 'error' ? hydrationState.message : undefined}
        onRetry={onRetry}
      />
    );
  } else if (state === 'empty') {
    content = (
      <EmptyState
        icon={Bot}
        title="No subagent messages"
        description="This subagent session completed without producing a transcript."
      />
    );
  } else {
    content = (
      <View className="flex-1 items-center justify-center px-6">
        <EmptyState
          icon={Bot}
          title="Loading subagent session"
          description="Waiting for subagent messages…"
        />
      </View>
    );
  }

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View className="flex-1 bg-background">
        <SheetHeader title={title} onDone={onClose} />
        {content}
      </View>
    </Modal>
  );
}
