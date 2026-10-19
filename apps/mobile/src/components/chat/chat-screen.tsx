import { type ListRenderItem } from '@shopify/flash-list';
import { type RemoteModelState, type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useTranslation } from 'react-i18next';

import { type ChatComposerSendOptions } from '@/components/agents/chat-composer';
import { MessageBubble } from '@/components/agents/message-bubble';
import { SessionContextMetrics } from '@/components/agents/session-context-metrics';
import { MessageDetailsSheet } from '@/components/agents/message-details-sheet';
import { PartDetailSheetHost } from '@/components/agents/part-detail-sheet-host';
import { SessionSkeletonMessages } from '@/components/agents/session-detail-skeleton';
import { SessionMessageList } from '@/components/agents/session-message-list';
import { EmptyState } from '@/components/empty-state';
import { ScreenHeader } from '@/components/screen-header';
import { MessageCircle, Wrench } from '@/components/ui/icons';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { useSessionModelOptions } from '@/lib/hooks/use-session-model-options';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrganization } from '@/lib/organization-context';
import { useChat, useChatList, useChatPlace } from '@/lib/chat/use-chat';
import { asMessages } from '@/lib/chat/turns';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { getChatBackendsHasLoaded, useChatBackends } from '@/lib/chat/backend-store';
import { useTargetSupportsImages } from '@/lib/chat/backend-capabilities';
import { rememberModelFacts } from '@/lib/chat/layers';
import { requiresBackendDisclosure } from '@/lib/chat/backend-model-options';
import { resolveChatTarget } from '@/lib/chat/backend-target';
import { useLocalModels } from '@/lib/chat/local-models';
import { useChatModelOptions } from '@/lib/chat/use-chat-model-options';
import { type EffortChoices, effortOfVariant, variantOfEffort } from '@/lib/chat/effort';

import { ChatTitle } from './chat-title';
import { ChatComposerArea } from './chat-composer-area';
import { ChatDetailsSheet } from './chat-details-sheet';
import { useChatDetails } from './chat-details-state';
import { McpSettingsSheet, useMcpSettings } from './mcp-settings-sheet';
import { BackendSettingsControl } from './backend-settings-sheet';
import { useChatMessageActions } from './use-chat-message-actions';
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

export function ChatScreen({ opened }: Readonly<ChatScreenProps>) {
  const { t } = useTranslation();
  const { organizationId } = useOrganization();
  const place = useChatPlace();
  const { state, send, stop, retry } = useChat(place, opened);
  const { chats, rename } = useChatList(place);
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
  const colors = useThemeColors();
  // What the tools control is in right now, in the same words the sheet's Kilo
  // row draws. `count` is carried for the available state and ignored by the rest.
  const mcpStatusText = t(mcp.view.statusKey, { count: mcp.view.toolCount });

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
  const availableOptions = useChatModelOptions(modelOptions.options, backends, localModels);

  // The model the next message goes to. It starts as the one the conversation
  // is on and changes the moment the person picks another, which is what makes
  // the switch apply to the next message and not to what was already said. The
  // effort works the same way: a reopened chat shows the one it was opened with.
  const [picked, setPicked] = useState<string | null>(null);
  const [pickedVariant, setPickedVariant] = useState<string | null>(null);
  const model = picked ?? state.model;
  const pickedOption = availableOptions.find(option => option.id === model);
  const choices: EffortChoices = {
    variants: pickedOption?.variants ?? [],
    efforts: models.find(option => option.id === model)?.variantEfforts,
  };
  const variant = pickedVariant ?? variantOfEffort(choices, state.effort);
  // Until the list loads, the chat keeps the effort it was opened with rather
  // than dropping it for a model the screen cannot see yet.
  const effort = pickedOption === undefined ? state.effort : effortOfVariant(choices, variant);
  const webSearch = useWebSearchSetting(state.sessionId, model);
  const imagesSupported = useTargetSupportsImages(model);

  // The attach control and the send path read image support from the gateway
  // list this screen loads, not only from the one the chat list loaded.
  useEffect(() => {
    rememberModelFacts(models);
  }, [models]);

  const selectModel = (modelId: string, variantId: string | null) => {
    const accept = () => {
      setPicked(modelId);
      setPickedVariant(variantId);
    };
    if (!requiresBackendDisclosure(model, modelId)) {
      accept();
      return;
    }
    const epoch = currentAuthEpoch();
    const name = availableOptions.find(option => option.id === modelId)?.name ?? modelId;
    Alert.alert(
      t('modelChat.backends.switchTitle'),
      t('modelChat.backends.switchMessage', { name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('modelChat.backends.switchConfirm'),
          onPress: () => {
            if (isCurrentAuthEpoch(epoch)) {
              accept();
            }
          },
        },
      ]
    );
  };

  // The provider control chooses the model this chat sends to, so the choice
  // goes through the same disclosure-protected switch the model picker uses. It
  // picks no thinking variant, so the chat's stored effort resolves the variant
  // the chosen model offers.
  const selectProviderModel = (modelId: string) => {
    selectModel(modelId, null);
  };

  const messages = asMessages(state);
  const actions = useChatMessageActions(state, messages, retry);
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

  const handleSend = useCallback(
    (text: string, options?: ChatComposerSendOptions) => {
      // Before the stored profiles load, every custom target looks deleted. The
      // registry waits for the load and validates the target itself.
      try {
        if (getChatBackendsHasLoaded()) {
          resolveChatTarget(model, backends);
        }
      } catch (error) {
        Alert.alert(
          t('modelChat.backends.title'),
          error instanceof Error ? error.message : t('modelChat.backends.invalidTarget')
        );
        throw error;
      }
      // The question is on screen the moment it is asked, so the composer
      // empties now rather than when the answer lands.
      options?.onOptimisticSend?.();
      void send(text, { model, effort }, options?.images ?? []);
    },
    [backends, effort, model, send, t]
  );

  const handleStop = useCallback(() => {
    void stop();
  }, [stop]);

  function renderTranscript() {
    if (state.status === 'opening') {
      // The chat is being reopened. A stored conversation has history that is
      // not on screen yet, so this is a transcript that is loading, not one
      // that is empty: the empty state waits for the open to finish.
      //
      // It is the sessions list's own placeholder — anchored to the bottom and
      // shaped like the bubbles — and it is rendered as a direct child of the
      // area so its fade-out plays as the stored transcript arrives. The
      // transcript lands where the placeholder stood instead of jumping from
      // the top of the area to the bottom when the open finishes.
      return <SessionSkeletonMessages sessionId={state.sessionId} />;
    }
    if (messages.length === 0) {
      return (
        <EmptyState
          icon={MessageCircle}
          // i18n-dup-ok: 'modelChat.empty.title' was renamed from the base catalog's
          // quickChat.empty.title in the harness-chat rebuild; no other live key carries it.
          title={t('modelChat.empty.title')}
          // i18n-dup-ok: 'modelChat.empty.description' was renamed from the base catalog's
          // quickChat.empty.description in the harness-chat rebuild; no other live key carries it.
          description={t('modelChat.empty.description')}
        />
      );
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
        />
      </PartDetailSheetHost>
    );
  }

  function renderBody() {
    return (
      <>
        <View className="flex-1">{renderTranscript()}</View>

        <ChatComposerArea
          status={state.status}
          messages={messages}
          failureKey={state.failureKey}
          retryable={!actions.hasUnanswered}
          onRetry={() => void retry()}
          onSend={handleSend}
          composerControlRef={actions.composerControlRef}
          onStop={handleStop}
          model={model}
          variant={variant}
          onModelSelect={selectModel}
          modelOptions={availableOptions}
          attachmentsEnabled={imagesSupported}
          organizationId={organizationId ?? undefined}
          disabled={modelsFailed && availableOptions.length === 0}
        />
      </>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={title}
        titleContent={
          <ChatTitle
            title={title}
            initialValue={summary?.title ?? ''}
            canRename={summary !== undefined}
            onRename={async name => {
              await rename(state.sessionId, name);
            }}
          />
        }
        headerRight={
          <View className="flex-row items-center">
            <SessionContextMetrics {...details.metrics} />
            <BackendSettingsControl selectedModel={model} onSelectModel={selectProviderModel} />
            <Pressable
              onPress={() => {
                setMcpOpen(true);
              }}
              accessibilityRole="button"
              accessibilityLabel={t('modelChat.mcp.title')}
              // The header control used to draw an unexplained status dot. The
              // state it stood for is named here and drawn in full by the sheet
              // this control opens.
              accessibilityValue={{ text: mcpStatusText }}
              className="h-11 w-11 items-center justify-center active:opacity-70"
            >
              <Wrench size={22} color={colors.foreground} />
            </Pressable>
          </View>
        }
        showBackButton
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
