import { type ListRenderItem } from '@shopify/flash-list';
import { type RemoteModelState, type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Platform, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ChatComposer } from '@/components/agents/chat-composer';
import { MessageBubble } from '@/components/agents/message-bubble';
import { SessionMessageList } from '@/components/agents/session-message-list';
import { SessionSkeletonMessages } from '@/components/agents/session-detail-skeleton';
import { getSessionKeyboardContainerKind } from '@/components/agents/session-keyboard-container-state';
import { AppAwareKeyboardPaddingView } from '@/components/kilo-chat/app-aware-keyboard-padding';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ContextControl } from '@/components/context-control';
import { ScreenHeader } from '@/components/screen-header';
import { useTabBarBottomPadding } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { MessageCircle } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/lib/auth/auth-context';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useSessionModelOptions } from '@/lib/hooks/use-session-model-options';
import { useOrganization } from '@/lib/organization-context';
import { useFencedDraftLoad } from '@/lib/persist/use-draft-load';

import { useQuickChat } from './use-quick-chat';

// The remote model branch is never taken for quick-chat (`activeSessionType`
// is null), but `useSessionModelOptions` requires a state of the right shape.
const QUICK_CHAT_REMOTE_MODEL_STATE: RemoteModelState = {
  ownerConnectionId: null,
  protocol: 'unknown',
  refresh: 'idle',
};

// Message rows carry no quick-chat state, so the renderer lives at module
// scope and is never recreated per render.
const renderItem: ListRenderItem<StoredMessage> = ({ item }) => <MessageBubble message={item} />;

/* eslint-disable require-await, @typescript-eslint/require-await, no-empty-function -- no-op async session callbacks required by ChatComposer's non-session API; quick-chat never creates, restarts, or exits a session */
async function noopSendCommand(): Promise<boolean> {
  return false;
}
async function noopCreateSession(): Promise<boolean> {
  return false;
}
async function noopRestartSession(): Promise<boolean> {
  return false;
}
async function noopExitSession(): Promise<void> {}
/* eslint-enable require-await, @typescript-eslint/require-await, no-empty-function */

export function QuickChatScreen() {
  const { organizationId } = useOrganization();
  const { authEpoch } = useAuth();
  return <ScopedQuickChatScreen key={`${authEpoch}:${organizationId ?? 'personal'}`} />;
}

function ScopedQuickChatScreen() {
  const { t } = useTranslation();
  const { organizationId } = useOrganization();
  const { authEpoch } = useAuth();
  const { userId, isLoading: isIdentityLoading } = useCurrentUserId();
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  const {
    models,
    isLoading: gatewayModelsLoading,
    isError: catalogError,
    refetch: refetchModels,
  } = useAvailableModels(organizationId ?? undefined);

  const modelOptions = useSessionModelOptions({
    activeSessionType: null,
    observedModel: null,
    remoteModelOverride: null,
    gatewayModels: models,
    gatewayModelsLoading,
    organizationId: organizationId ?? undefined,
    remoteModelState: QUICK_CHAT_REMOTE_MODEL_STATE,
  });

  // The composer shows the session model options; the default model is the
  // first gateway option until the user picks a different one.
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  const [pickedVariant, setPickedVariant] = useState('');
  const model = pickedModel ?? (modelOptions.selectedValue || (modelOptions.options[0]?.id ?? ''));
  const variant = pickedModel !== null ? pickedVariant : modelOptions.selectedVariant;

  const chat = useQuickChat(model);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => {
      setKeyboardVisible(true);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardVisible(false);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const tabBarBottomPadding = useTabBarBottomPadding();
  const keyboardContainerKind = getSessionKeyboardContainerKind(Platform.OS);
  const composerScope = `${authEpoch}:${organizationId ?? 'personal'}`;
  const draftKey = `quick-chat:${composerScope}`;
  const composerDraft = useFencedDraftLoad({ userId, isIdentityLoading, entityKey: draftKey });
  const composerBottomPadding = keyboardVisible ? 0 : tabBarBottomPadding;
  // Passthrough aliases keep the JSX handler values in the `handle*` convention.
  const handleSend = chat.onSend;
  const handleStop = chat.onStop;
  const handleLoadOlderMessages = chat.onLoadOlderMessages;

  const listErrorCode = chat.isError
    ? (chat.error as { data?: { code?: string } } | null)?.data?.code
    : undefined;
  const nonRetryableHistoryError =
    listErrorCode === 'NOT_FOUND' ||
    listErrorCode === 'FORBIDDEN' ||
    listErrorCode === 'UNAUTHORIZED';
  // A compact Retry only renders above the composer once rows exist: an empty
  // transcript shows either the full-region catalog QueryError or the history
  // error, each with its own Retry.
  const showRetryAboveComposer =
    (catalogError && chat.messages.length > 0) || (chat.messages.length > 0 && chat.isError);

  const handleModelSelect = (modelId: string, variantId: string) => {
    setPickedModel(modelId);
    setPickedVariant(variantId);
  };

  function renderTranscript() {
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- `isLoading` is false while the query is disabled before the org scope hydrates
    if (chat.isLoading && chat.messages.length === 0) {
      return <SessionSkeletonMessages sessionId={chat.threadId ?? undefined} />;
    }

    if (chat.isError && chat.messages.length === 0) {
      if (nonRetryableHistoryError) {
        return <QueryError variant={listErrorCode === 'NOT_FOUND' ? 'not-found' : 'permission'} />;
      }
      return (
        <QueryError
          variant="server"
          title={t('quickChat.historyRetry')}
          onRetry={() => {
            void chat.refetch();
          }}
        />
      );
    }

    if (catalogError && chat.messages.length === 0) {
      return (
        <QueryError
          variant="server"
          title={t('common.couldNotLoadModels')}
          onRetry={() => {
            void refetchModels();
          }}
        />
      );
    }

    if (chat.messages.length === 0) {
      return (
        <EmptyState
          icon={MessageCircle}
          title={t('quickChat.empty.title')}
          description={t('quickChat.empty.description')}
        />
      );
    }

    return (
      <SessionMessageList<StoredMessage>
        sessionId={chat.threadId ?? 'pending'}
        items={chat.messages}
        keyExtractor={message => message.info.id}
        hasOlderMessages={chat.hasOlderMessages}
        isLoadingOlderMessages={chat.isLoadingOlderMessages}
        olderMessagesError={chat.olderMessagesError}
        olderMessagesOmittedItemCount={chat.olderMessagesOmittedItemCount}
        onLoadOlderMessages={handleLoadOlderMessages}
        renderItem={renderItem}
      />
    );
  }

  function renderKeyboardBody() {
    return (
      <>
        <View className="flex-1">{renderTranscript()}</View>

        {/* Inline working row between the transcript and the composer. */}
        {chat.isStreaming && chat.messages.length > 0 ? (
          <View className="flex-row items-center gap-2 px-4 py-2">
            <ActivityIndicator />
            <Text variant="muted" className="text-xs">
              {t('quickChat.working')}
            </Text>
          </View>
        ) : null}

        {/* Compact retry above the composer, only once rows exist: a history
            refetch or model-catalog failure after messages were already shown. */}
        {showRetryAboveComposer ? (
          <View className="px-4 pb-2">
            <Button
              variant="outline"
              size="sm"
              accessibilityLabel={
                catalogError ? t('common.couldNotLoadModels') : t('quickChat.historyRetry')
              }
              onPress={() => {
                void chat.refetch();
                void refetchModels();
              }}
            >
              <Text>{t('common.retry')}</Text>
            </Button>
          </View>
        ) : null}

        <View style={{ paddingBottom: composerBottomPadding }}>
          <ChatComposer
            key={composerScope}
            draftKey={draftKey}
            initialDraft={composerDraft.settled ? (composerDraft.value ?? '') : undefined}
            onSend={handleSend}
            onSendCommand={noopSendCommand}
            onCreateSession={noopCreateSession}
            onRestartSession={noopRestartSession}
            onExitSession={noopExitSession}
            onStop={handleStop}
            isStreaming={chat.isStreaming}
            placeholder={t('common.message')}
            mode="ask"
            onModeChange={() => {
              // Mode is locked to ask; any picker change snaps back on the next render.
            }}
            model={model}
            variant={variant}
            modelOptions={modelOptions.options}
            onModelSelect={handleModelSelect}
            attachmentsEnabled={false}
            activeSessionType={null}
            organizationId={organizationId ?? undefined}
          />
        </View>
      </>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('quickChat.title')}
        showBackButton={false}
        context={<ContextControl />}
      />
      {keyboardContainerKind === 'app-aware-padding' ? (
        <AppAwareKeyboardPaddingView className="flex-1">
          {renderKeyboardBody()}
        </AppAwareKeyboardPaddingView>
      ) : (
        <KeyboardAvoidingView className="flex-1" behavior="padding">
          {renderKeyboardBody()}
        </KeyboardAvoidingView>
      )}
    </View>
  );
}
