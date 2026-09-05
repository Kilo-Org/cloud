import { type ListRenderItem } from '@shopify/flash-list';
import { type RemoteModelState, type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { ChatComposer, type ChatComposerSendOptions } from '@/components/agents/chat-composer';
import { MessageBubble } from '@/components/agents/message-bubble';
import { SessionMessageList } from '@/components/agents/session-message-list';
import { getSessionKeyboardContainerKind } from '@/components/agents/session-keyboard-container-state';
import { AppAwareKeyboardPaddingView } from '@/components/kilo-chat/app-aware-keyboard-padding';
import { EmptyState } from '@/components/empty-state';
import { ScreenHeader } from '@/components/screen-header';
import { MessageCircle } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { useSessionModelOptions } from '@/lib/hooks/use-session-model-options';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useOrganization } from '@/lib/organization-context';
import { chatPlaceOf, useChat } from '@/lib/chat/use-chat';
import { asMessages } from '@/lib/chat/turns';

import { BetaPill } from './beta-pill';

/**
 * One conversation.
 *
 * The transcript, the composer and the bubbles are the ones every other
 * conversation in this app uses. What is different is underneath: the turns
 * come from the harness SDK on the device rather than from a session on a
 * server, so nothing here polls and nothing here reconnects.
 */

// The remote branch is never taken here (`activeSessionType` is null), but the
// hook wants a state of the right shape.
const NO_REMOTE: RemoteModelState = {
  ownerConnectionId: null,
  protocol: 'unknown',
  refresh: 'idle',
};

/* eslint-disable require-await, @typescript-eslint/require-await, no-empty-function -- the composer's session callbacks; a chat creates, restarts and exits nothing */
async function noSessionCommand(): Promise<boolean> {
  return false;
}
async function noSessionChange(): Promise<boolean> {
  return false;
}
async function noSessionExit(): Promise<void> {}
/* eslint-enable require-await, @typescript-eslint/require-await, no-empty-function */

type ChatScreenProps = {
  /** The session the route named. A model switch moves the chat off it. */
  opened: string;
};

export function ChatScreen({ opened }: Readonly<ChatScreenProps>) {
  const { t } = useTranslation();
  const { organizationId } = useOrganization();
  const { userId } = useCurrentUserId();
  const place = chatPlaceOf(userId, organizationId);
  const { state, send, stop, retry } = useChat(place, opened);
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  const {
    models,
    isLoading: modelsLoading,
    isError: modelsFailed,
  } = useAvailableModels(organizationId ?? undefined);

  const modelOptions = useSessionModelOptions({
    activeSessionType: null,
    observedModel: null,
    remoteModelOverride: null,
    gatewayModels: models,
    gatewayModelsLoading: modelsLoading,
    organizationId: organizationId ?? undefined,
    remoteModelState: NO_REMOTE,
  });

  // The model the next message goes to. It starts as the one the conversation
  // is on and changes the moment the person picks another, which is what makes
  // the switch apply to the next message and not to what was already said.
  const [picked, setPicked] = useState<string | null>(null);
  const [variant, setVariant] = useState('');
  const model = picked ?? state.model;

  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () => {
      setKeyboardVisible(true);
    });
    const hidden = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardVisible(false);
    });
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  const messages = asMessages(state);
  // The question that has no answer is the last thing on screen, and while the
  // chat is idle it is the one that offers a Retry.
  const unanswered =
    state.status === 'idle' && state.asked !== null ? messages.at(-1)?.info.id : undefined;

  const renderItem: ListRenderItem<StoredMessage> = useCallback(
    ({ item }) => (
      <MessageBubble
        message={item}
        {...(item.info.id === unanswered
          ? {
              deliveryState: {
                status: 'failed' as const,
                error: 'unanswered',
                reason: 'interrupted' as const,
              },
              onRetryMessage: () => {
                void retry();
              },
            }
          : {})}
      />
    ),
    [retry, unanswered]
  );

  const handleSend = useCallback(
    (text: string, options?: ChatComposerSendOptions) => {
      // The question is on screen the moment it is asked, so the composer
      // empties now rather than when the answer lands.
      options?.onOptimisticSend?.();
      void send(text, model);
    },
    [model, send]
  );

  const handleStop = useCallback(() => {
    void stop();
  }, [stop]);

  const keyboardKind = getSessionKeyboardContainerKind(Platform.OS);
  const { bottom } = useSafeAreaInsets();
  // A conversation fills the screen: the tab bar is gone and the composer sits
  // on the home indicator, except while the keyboard covers it.
  const composerPadding = { paddingBottom: keyboardVisible ? 0 : bottom };

  function renderTranscript() {
    if (messages.length === 0) {
      return (
        <EmptyState
          icon={MessageCircle}
          title={t('modelChat.empty.title')}
          description={t('modelChat.empty.description')}
        />
      );
    }
    return (
      <SessionMessageList<StoredMessage>
        sessionId={state.sessionId}
        items={messages}
        keyExtractor={message => message.info.id}
        hasOlderMessages={false}
        isLoadingOlderMessages={false}
        olderMessagesError={null}
        olderMessagesOmittedItemCount={0}
        onLoadOlderMessages={() => undefined}
        renderItem={renderItem}
      />
    );
  }

  function renderBody() {
    return (
      <>
        <View className="flex-1">{renderTranscript()}</View>

        {state.status === 'working' ? (
          <View className="flex-row items-center gap-2 px-4 py-2">
            <ActivityIndicator />
            <Text variant="muted" className="text-xs">
              {t('modelChat.working')}
            </Text>
          </View>
        ) : null}

        <View style={composerPadding}>
          <ChatComposer
            onSend={handleSend}
            onSendCommand={noSessionCommand}
            onCreateSession={noSessionChange}
            onRestartSession={noSessionChange}
            onExitSession={noSessionExit}
            onStop={handleStop}
            isStreaming={state.status === 'working'}
            placeholder={t('modelChat.composer.placeholder')}
            mode="ask"
            onModeChange={() => {
              // A chat is only ever an ask.
            }}
            model={model}
            variant={variant}
            modelOptions={modelOptions.options}
            onModelSelect={(modelId, variantId) => {
              setPicked(modelId);
              setVariant(variantId);
            }}
            attachmentsEnabled={false}
            activeSessionType={null}
            organizationId={organizationId ?? undefined}
            disabled={modelsFailed && modelOptions.options.length === 0}
          />
        </View>
      </>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('modelChat.title')}
        titleContent={
          <View className="flex-row items-center gap-2">
            <Text className="text-lg font-semibold text-foreground" numberOfLines={1}>
              {t('modelChat.title')}
            </Text>
            <BetaPill />
          </View>
        }
        showBackButton
      />
      {keyboardKind === 'app-aware-padding' ? (
        <AppAwareKeyboardPaddingView className="flex-1">{renderBody()}</AppAwareKeyboardPaddingView>
      ) : (
        <KeyboardAvoidingView className="flex-1" behavior="padding">
          {renderBody()}
        </KeyboardAvoidingView>
      )}
    </View>
  );
}
