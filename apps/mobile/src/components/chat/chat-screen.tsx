import { type ListRenderItem } from '@shopify/flash-list';
import { type RemoteModelState, type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { type Href, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useTranslation } from 'react-i18next';

import { type ChatComposerSendOptions } from '@/components/agents/chat-composer';
import { MessageBubble } from '@/components/agents/message-bubble';
import { MessageDetailsSheet } from '@/components/agents/message-details-sheet';
import { PartDetailSheetHost } from '@/components/agents/part-detail-sheet-host';
import { SessionSkeletonMessages } from '@/components/agents/session-detail-skeleton';
import { SessionMessageList } from '@/components/agents/session-message-list';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { useSessionModelOptions } from '@/lib/hooks/use-session-model-options';
import { useOrganization } from '@/lib/organization-context';
import { useChat, useChatList, useChatPlace } from '@/lib/chat/use-chat';
import { CHAT_UNAVAILABLE_KEY } from '@/lib/chat/state';
import { asMessages } from '@/lib/chat/turns';
import { getChatBackendsHasLoaded, useChatBackends } from '@/lib/chat/backend-store';
import { useTargetSupportsImages } from '@/lib/chat/backend-capabilities';
import { rememberModelFacts } from '@/lib/chat/layers';
import { CREDITS_FAILURE_KEY, resolveChatTarget } from '@/lib/chat/backend-target';
import { useLocalModels } from '@/lib/chat/local-models';
import { useChatModelOptions } from '@/lib/chat/use-chat-model-options';
import { prepareSend } from '@/lib/chat/sync/sync-send';
import { discardAndReload, pullOpenedChat } from '@/lib/chat/sync/sync-service';
import { useChatSyncGate, useChatSyncUploader, useSyncBanner } from '@/lib/chat/sync/use-chat-sync';

import { ChatComposerArea } from './chat-composer-area';
import { ChatTranscriptFailure } from './chat-transcript-failure';
import { ChatDetailsSheet } from './chat-details-sheet';
import { ChatEmptyState } from './chat-empty-state';
import { useChatDetails } from './chat-details-state';
import { McpSettingsSheet, useMcpSettings } from './mcp-settings-sheet';
import { ChatScreenHeader } from './chat-screen-header';
import { useChatMessageActions } from './use-chat-message-actions';
import { useChatAddCredits } from './use-chat-add-credits';
import { ChatSyncBanner } from './chat-sync-banners';
import { useChatScreenModel } from './use-chat-screen-model';
import { useWebSearchSetting } from './web-search-row';

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

type ChatScreenProps = {
  /** The session the route named. A model switch moves the chat off it. */
  opened: string;
};

/**
 * The chats a chat was opened from, and the destination its error state's Back
 * names. A chat is also reachable without that list beneath it — a deep link,
 * or a stack where the list itself already left — so Back cannot just pop and
 * inherit whatever route happens to be there.
 */
const CHAT_LIST_HREF: Href = '/(app)/(tabs)/(4_chat)';

export function ChatScreen({ opened }: Readonly<ChatScreenProps>) {
  const { t } = useTranslation();
  const router = useRouter();
  const { organizationId } = useOrganization();
  const place = useChatPlace();
  const { state, send, stop, retry } = useChat(place, opened);
  const { chats, rename } = useChatList(place);
  const gate = useChatSyncGate(place);
  useChatSyncUploader(place, gate.enabled);
  const banner = useSyncBanner(state.sessionId);
  const syncSessionId = state.sessionId;
  useEffect(() => {
    if (gate.enabled && place !== null) {
      void pullOpenedChat(place, syncSessionId);
    }
  }, [gate.enabled, place, syncSessionId]);
  // A chat is listed once its session is written. Until then it has no row to name.
  const summary = chats.find(chat => chat.sessionId === state.sessionId);
  const title = summary === undefined || summary.title === '' ? t('common.chat') : summary.title;
  // The sheet's whole model — the Kilo control, the settings-tools group switch
  // and the remote servers — is read here. The header draws its dot from the
  // Kilo view, so the control and the sheet cannot disagree.
  const [mcpOpen, setMcpOpen] = useState(false);
  const backends = useChatBackends();
  const localModels = useLocalModels();
  const mcp = useMcpSettings(place, state.sessionId);
  // What the tools control is in right now, in the same words the sheet's Kilo
  // row draws. `count` is carried for the available state and ignored by the rest.
  const mcpStatusText = t(mcp.view.statusKey, { count: mcp.view.toolCount });

  const {
    models,
    isLoading: modelsLoading,
    isError: modelsFailed,
    refetch: refetchModels,
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
  const availableOptions = useChatModelOptions(modelOptions.options, backends, localModels);

  // The model the next message goes to, and its effort: a reopened chat shows
  // the pair it was opened with until the person picks another.
  const { model, variant, effort, selectModel, selectProviderModel } = useChatScreenModel({
    currentModel: state.model,
    currentEffort: state.effort,
    options: availableOptions,
    gatewayModels: models,
    t,
  });
  const webSearch = useWebSearchSetting(place, state.sessionId, model);
  const imagesSupported = useTargetSupportsImages(model);

  // The attach control and the send path read image support from the gateway
  // list this screen loads, not only from the one the chat list loaded.
  useEffect(() => {
    rememberModelFacts(models);
  }, [models]);

  // Where the account buys the credit a refused send needs. Both the failed
  // question and the row above the composer reach it through this one action.
  const addCredits = useChatAddCredits(place);

  const messages = asMessages(state);
  const actions = useChatMessageActions(state, messages, { retry, addCredits });
  const { actionsFor } = actions;
  const details = useChatDetails({
    model: state.model === '' ? model : state.model,
    record: state.record,
    modelOptions: availableOptions,
    backends,
    mcp,
    hasMessages: messages.length > 0,
  });

  const renderItem: ListRenderItem<StoredMessage> = useCallback(
    ({ item }) => <MessageBubble message={item} {...actionsFor(item)} />,
    [actionsFor]
  );

  // A send takes the transcript position over, so the question and its answer
  // are on screen even when the person had scrolled up to read.
  const [followTailNonce, setFollowTailNonce] = useState(0);

  const handleSend = useCallback(
    async (text: string, options?: ChatComposerSendOptions) => {
      // A synced chat pulls before its turn (H6): the turn runs here, goes
      // to a live runner elsewhere, or waits behind the busy banner. A
      // blocked send throws, which is how the composer keeps the draft.
      if (gate.enabled && place !== null) {
        const decision = await prepareSend(place, state.sessionId, text);
        if (decision.kind === 'blocked') {
          throw new Error(t('modelChat.sync.busyBody'));
        }
        if (decision.kind === 'relayed') {
          options?.onOptimisticSend?.();
          setFollowTailNonce(count => count + 1);
          return;
        }
      }
      // Before the stored profiles load, every custom target looks deleted. The
      // registry waits for the load and validates the target itself.
      try {
        if (getChatBackendsHasLoaded()) {
          resolveChatTarget(model, backends);
        }
      } catch (error) {
        Alert.alert(
          t('modelChat.backends.title'),
          error instanceof Error ? error.message : t('modelChat.backends.invalidTarget'),
          undefined,
          { cancelable: true }
        );
        throw error;
      }
      options?.onOptimisticSend?.();
      setFollowTailNonce(count => count + 1);
      void send(text, { model, effort }, options?.images ?? []);
    },
    [backends, effort, gate.enabled, model, place, send, state.sessionId, t]
  );

  const handleStop = useCallback(() => {
    void stop();
  }, [stop]);

  // A chat that settled with a failure and no transcript has nothing to read:
  // the failure is the transcript. The area draws it once, in place of the
  // empty state, so the screen does not show a chat that is ready for a first
  // message beside an error saying there is nothing to open.
  const transcriptFailure =
    state.status === 'idle' && messages.length === 0 ? state.failureKey : null;
  // A chat that is not one this place may read is not one this place can retry
  // into: entering it again settles the same state. Neither is a send the
  // balance refused: a re-send meets the same refusal, so the action that
  // settles it is Add credits, never a Retry.
  const creditsRefused = state.failureKey === CREDITS_FAILURE_KEY;
  const retryable =
    !actions.hasUnanswered && state.failureKey !== CHAT_UNAVAILABLE_KEY && !creditsRefused;
  // A question with no answer states its own failure and carries its own
  // recovery, so the row above the composer does not repeat it. With no
  // question on screen that row is the only place that can state a failure, and
  // the only place that can offer its action.
  const rowFailureKey = actions.hasUnanswered ? null : state.failureKey;

  function renderTranscript() {
    if (state.status === 'opening') {
      // The chat is being reopened. A stored conversation has history that is
      // not on screen yet, so this is a transcript that is loading, not one
      // that is empty: the empty state waits for the open to finish.
      //
      // It is the sessions list's own placeholder — anchored to the bottom and
      // shaped like the bubbles — so the transcript lands where the placeholder
      // stood instead of jumping from the top of the area to the bottom when
      // the open finishes.
      return <SessionSkeletonMessages sessionId={state.sessionId} />;
    }
    if (transcriptFailure !== null) {
      return (
        <ChatTranscriptFailure
          failureKey={transcriptFailure}
          retryable={retryable}
          onRetry={() => void retry()}
          onBack={() => {
            // POP_TO keeps the list's scroll position when the chat was opened
            // from it, and puts the list on the stack when it was not.
            router.dismissTo(CHAT_LIST_HREF);
          }}
        />
      );
    }
    if (messages.length === 0) {
      return <ChatEmptyState />;
    }
    // The host lets a folded thinking row open its text in the part sheet.
    return (
      <PartDetailSheetHost messages={messages}>
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
          followTailNonce={followTailNonce}
        />
      </PartDetailSheetHost>
    );
  }

  function renderBody() {
    return (
      <>
        <View className="flex-1">{renderTranscript()}</View>
        <ChatSyncBanner
          banner={banner}
          onDiscard={() => {
            if (place === null) {
              return;
            }
            void (async () => {
              const restored = await discardAndReload(place, state.sessionId, state.turns);
              if (restored !== '') {
                actions.composerControlRef.current?.setText(restored);
              }
            })();
          }}
        />

        {/* A failure with no transcript owns the screen: there is no chat to
            type into, so the composer would offer a question the state cannot
            take, and sit beside the state's own way out as a second answer to
            the same screen. It returns as soon as the chat has a transcript. */}
        {transcriptFailure === null ? (
          <ChatComposerArea
            status={state.status}
            messages={messages}
            failureKey={rowFailureKey}
            retryable={retryable}
            onRetry={() => void retry()}
            addCredits={addCredits}
            onSend={(text, options) => void handleSend(text, options)}
            composerControlRef={actions.composerControlRef}
            onStop={handleStop}
            model={model}
            variant={variant}
            onModelSelect={selectModel}
            modelOptions={availableOptions}
            isLoadingModels={modelOptions.isLoading}
            onRetryModels={() => void refetchModels()}
            attachmentsEnabled={imagesSupported}
            organizationId={organizationId ?? undefined}
            disabled={
              (modelsFailed && availableOptions.length === 0) ||
              banner.kind === 'busy' ||
              banner.kind === 'diverged'
            }
          />
        ) : null}
      </>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ChatScreenHeader
        title={title}
        summary={summary}
        onRename={name => rename(state.sessionId, name)}
        metrics={details.metrics}
        // A reopened chat resolves before it can report any usage, so the pill
        // keeps its loading bar over the value row until the open finishes.
        loading={state.status === 'opening'}
        model={model}
        onSelectProviderModel={selectProviderModel}
        mcpStatusText={mcpStatusText}
        onOpenMcp={() => {
          setMcpOpen(true);
        }}
      />
      <KeyboardAvoidingView className="flex-1" behavior="padding">
        {renderBody()}
      </KeyboardAvoidingView>
      <McpSettingsSheet
        visible={mcpOpen}
        onClose={() => {
          setMcpOpen(false);
        }}
        settings={mcp}
        webSearch={webSearch}
      />
      <MessageDetailsSheet {...actions.details} modelOptions={modelOptions.options} />
      <ChatDetailsSheet {...details.sheet} />
    </View>
  );
}
