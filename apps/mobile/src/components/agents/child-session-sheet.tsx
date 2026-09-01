import { type ReactNode, useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import {
  type ChildSessionHydrationState,
  type OlderMessagesError,
  type StoredMessage,
} from '@kilocode/cloud-agent-sdk';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { SheetHeader } from '@/components/sheet-header';
import { Bot } from '@/components/ui/icons';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import {
  ChildSessionMessage,
  type OpenChildSession,
  type RenderPartFn,
} from './child-session-section';
import { getChildSessionModelLabel } from './child-session-model';
import { ChildSessionModelLabel } from './child-session-model-label';
import { MessageErrorBoundary } from './message-error-boundary';
import { PartDetailSheetHost } from './part-detail-sheet-host';
import { getChildSessionSheetState } from './child-session-sheet-state';
import { SessionMessageList } from './session-message-list';
import { SessionPageSheet } from './session-page-sheet';
import { SessionStatusIndicator } from './session-status-indicator';
import { WorkingIndicator } from './working-indicator';

type ChildSessionSheetProps = {
  visible: boolean;
  sessionId: string;
  title: string;
  getChildMessages: (sessionId: string) => StoredMessage[];
  hydrationState: ChildSessionHydrationState;
  sessionError: string | null;
  isStreaming: boolean;
  hasOlderMessages: boolean;
  isLoadingOlderMessages: boolean;
  olderMessagesError: OlderMessagesError | null;
  olderMessagesOmittedItemCount: number;
  onLoadOlderMessages: () => void;
  renderPart: RenderPartFn;
  onOpenChildSession: OpenChildSession;
  onRetry: () => void;
  onClose: () => void;
  /** Fires on iOS after the native pageSheet dismiss animation completes. */
  onDismiss?: () => void;
  modelOptions?: SessionModelOption[];
};

export function ChildSessionSheet({
  visible,
  sessionId,
  title,
  getChildMessages,
  hydrationState,
  sessionError,
  isStreaming,
  hasOlderMessages,
  isLoadingOlderMessages,
  olderMessagesError,
  olderMessagesOmittedItemCount,
  onLoadOlderMessages,
  renderPart,
  onOpenChildSession,
  onRetry,
  onClose,
  onDismiss,
  modelOptions,
}: Readonly<ChildSessionSheetProps>) {
  const messages = getChildMessages(sessionId);
  const state = getChildSessionSheetState(hydrationState, messages.length, sessionError);
  const modelLabel = getChildSessionModelLabel(messages, modelOptions ?? []);
  const { t } = useTranslation();
  // Hydration drops its error while retrying. Retain this child's copy so
  // the recovery controls stay mounted until the request settles.
  const [lastHydrationError, setLastHydrationError] = useState<{
    sessionId: string;
    message: string | null;
  }>({ sessionId, message: null });
  let hydrationError: string | null = null;
  if (hydrationState.status === 'error') {
    hydrationError = hydrationState.message;
  } else if (hydrationState.status === 'loading' && lastHydrationError.sessionId === sessionId) {
    hydrationError = lastHydrationError.message;
  }
  if (lastHydrationError.sessionId !== sessionId || lastHydrationError.message !== hydrationError) {
    setLastHydrationError({ sessionId, message: hydrationError });
  }
  // Safe-area context can return 0 inside a RN `Modal` (pageSheet doesn't
  // always propagate the home-indicator inset), so we floor the value with
  // a comfortable constant to keep the last row / working indicator clear
  // of the home indicator on curved-bottom devices.
  const insets = useSafeAreaInsets();
  const sheetBottomInset = Math.max(insets.bottom, 16);
  let content: ReactNode = null;

  if (state === 'content') {
    content = (
      <View className="flex-1">
        {sessionError ? (
          <SessionStatusIndicator
            indicator={{ type: 'error', message: sessionError, timestamp: 0 }}
          />
        ) : null}
        {hydrationError !== null ? (
          <QueryError
            title={t('agentChat.childSessionSheet.couldNotLoad')}
            message={hydrationError}
            onRetry={onRetry}
            isRetrying={hydrationState.status === 'loading'}
            className="flex-none gap-3 border-b border-border py-3"
          />
        ) : null}
        <SessionMessageList
          sessionId={sessionId}
          items={messages}
          keyExtractor={message => message.info.id}
          hasOlderMessages={hasOlderMessages}
          isLoadingOlderMessages={isLoadingOlderMessages}
          olderMessagesError={olderMessagesError}
          olderMessagesOmittedItemCount={olderMessagesOmittedItemCount}
          onLoadOlderMessages={onLoadOlderMessages}
          renderItem={({ item }) => (
            <MessageErrorBoundary>
              <View className="px-4 py-1">
                <ChildSessionMessage
                  message={item}
                  depth={0}
                  getChildMessages={getChildMessages}
                  renderPart={renderPart}
                  onOpenChildSession={onOpenChildSession}
                  modelOptions={modelOptions}
                />
              </View>
            </MessageErrorBoundary>
          )}
          ListFooterComponent={<WorkingIndicator messages={messages} isStreaming={isStreaming} />}
          contentBottomInset={sheetBottomInset}
        />
      </View>
    );
  } else if (state === 'error') {
    content =
      hydrationState.status === 'error' ? (
        <QueryError
          title={t('agentChat.childSessionSheet.couldNotLoad')}
          message={hydrationState.message}
          onRetry={onRetry}
        />
      ) : (
        <QueryError
          title={t('agentChat.childSessionSheet.failed')}
          message={sessionError ?? undefined}
        />
      );
  } else if (state === 'empty') {
    content = (
      <EmptyState
        icon={Bot}
        title={t('agentChat.childSessionSheet.noMessages')}
        description={t('agentChat.childSessionSheet.noMessagesDescription')}
      />
    );
  } else {
    content = (
      <View className="flex-1 items-center justify-center px-6">
        <EmptyState
          icon={Bot}
          title={t('agentChat.childSessionSheet.loading')}
          description={t('agentChat.childSessionSheet.loadingDescription')}
        />
      </View>
    );
  }

  return (
    <SessionPageSheet visible={visible} onClose={onClose} onDismiss={onDismiss}>
      <SheetHeader title={title} wrapTitle onDone={onClose} />
      {modelLabel ? (
        <View className="border-b border-border px-4 py-2">
          <ChildSessionModelLabel modelLabel={modelLabel} />
        </View>
      ) : null}
      <PartDetailSheetHost messages={messages}>{content}</PartDetailSheetHost>
    </SessionPageSheet>
  );
}
