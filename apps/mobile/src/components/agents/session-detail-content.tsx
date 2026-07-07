/* eslint-disable max-lines -- Session orchestration and its render paths are kept together. */
import { type CloudStatus, type KiloSessionId, type StoredMessage } from 'cloud-agent-sdk';
import { useAtomValue } from 'jotai';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';

import { ChatComposer } from '@/components/agents/chat-composer';
import { ConnectivityBanner } from '@/components/agents/connectivity-banner';
import { MessageBubble } from '@/components/agents/message-bubble';
import {
  ModelPickerSelectionScopeProvider,
  SessionModelNotices,
} from '@/components/agents/model-selector';
import { PermissionCard } from '@/components/agents/permission-card';
import { QuestionCard } from '@/components/agents/question-card';
import { getSessionKeyboardContainerKind } from '@/components/agents/session-keyboard-container-state';
import { useSessionManager } from '@/components/agents/session-provider';
import { SessionStatusIndicator } from '@/components/agents/session-status-indicator';
import {
  shouldShowAgentWorkingIndicator,
  shouldShowFooterWorkingIndicator,
} from '@/components/agents/session-working-state';
import { AppAwareKeyboardPaddingView } from '@/components/kilo-chat/app-aware-keyboard-padding';
import { useInteractionHandlers } from '@/components/agents/use-interaction-handlers';
import { useSessionAutoScroll } from '@/components/agents/use-session-auto-scroll';
import { useSessionConfigSync } from '@/components/agents/use-session-config-sync';
import { WorkingIndicator } from '@/components/agents/working-indicator';
import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { type AgentAttachmentWire } from '@/lib/agent-attachments/use-agent-attachment-upload';
import { useAppLifecycle } from '@/lib/hooks/use-app-lifecycle';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { useModelPreferences } from '@/lib/hooks/use-model-preferences';
import { usePersistedAgentModel } from '@/lib/hooks/use-persisted-agent-model';
import { useReasoningPreference } from '@/lib/hooks/use-reasoning-preference';
import {
  createRemoteModelOverride,
  revalidateLegacyGatewayOverride,
  useSessionModelOptions,
} from '@/lib/hooks/use-session-model-options';
import {
  areModelPickerSelectionScopesEqual,
  type ModelPickerSelection,
  type ModelPickerSelectionScope,
} from '@/lib/picker-bridge';

type SessionDetailContentProps = {
  sessionId: KiloSessionId;
};

const COMPOSER_PLACEHOLDERS: Partial<Record<CloudStatus['type'], string>> = {
  preparing: 'Setting up environment...',
  finalizing: 'Wrapping up...',
};

export function SessionDetailContent({ sessionId }: Readonly<SessionDetailContentProps>) {
  const manager = useSessionManager();

  const messages = useAtomValue(manager.atoms.messagesList);
  const isLoading = useAtomValue(manager.atoms.isLoading);
  const error = useAtomValue(manager.atoms.error);
  const fetchedData = useAtomValue(manager.atoms.fetchedSessionData);
  const sessionConfig = useAtomValue(manager.atoms.sessionConfig);
  const isStreaming = useAtomValue(manager.atoms.isStreaming);
  const statusIndicator = useAtomValue(manager.atoms.statusIndicator);
  const cloudStatus = useAtomValue(manager.atoms.cloudStatus);
  const canSend = useAtomValue(manager.atoms.canSend);
  const isReadOnly = useAtomValue(manager.atoms.isReadOnly);
  const supportsAttachments = useAtomValue(manager.atoms.supportsAttachments);
  const activeQuestion = useAtomValue(manager.atoms.activeQuestion);
  const activePermission = useAtomValue(manager.atoms.activePermission);
  const totalCost = useAtomValue(manager.atoms.totalCost);
  const getChildMessages = useAtomValue(manager.atoms.childMessages);
  const pendingMessages = useAtomValue(manager.atoms.pendingMessages);
  const activeSessionType = useAtomValue(manager.atoms.activeSessionType);
  const remoteModelState = useAtomValue(manager.atoms.remoteModelState);
  const observedModel = useAtomValue(manager.atoms.observedModel);
  const remoteModelOverride = useAtomValue(manager.atoms.remoteModelOverride);

  const { isConnected } = useAppLifecycle();
  const { bottom } = useSafeAreaInsets();

  const {
    isAnswering,
    isRespondingToPermission,
    handleAnswerQuestion,
    handleRejectQuestion,
    handleRespondToPermission,
  } = useInteractionHandlers({ manager, activeQuestion, activePermission });

  const organizationId = fetchedData?.organizationId ?? undefined;

  const { saveModel: savePersistedModel } = usePersistedAgentModel();
  const { setLastSelected: persistServerLastSelected } = useModelPreferences(organizationId);
  const { defaultExpanded: reasoningDefaultExpanded } = useReasoningPreference();
  const { models: gatewayModels, isLoading: gatewayModelsLoading } =
    useAvailableModels(organizationId);
  const sessionModels = useSessionModelOptions({
    activeSessionType,
    remoteModelState,
    observedModel,
    remoteModelOverride,
    gatewayModels,
    gatewayModelsLoading,
    organizationId,
  });
  const modelOptions = sessionModels.options;
  const catalogGenerationIdentity =
    remoteModelState.protocol === 'v1' ? (remoteModelState.catalog ?? null) : gatewayModels;
  const modelPickerSelectionScope = useMemo<ModelPickerSelectionScope>(
    () => ({
      sessionId,
      ownerConnectionId: remoteModelState.ownerConnectionId,
      protocol: remoteModelState.protocol,
      catalogGenerationIdentity,
    }),
    [
      catalogGenerationIdentity,
      remoteModelState.ownerConnectionId,
      remoteModelState.protocol,
      sessionId,
    ]
  );
  const liveModelPickerSelectionScopeRef = useRef(modelPickerSelectionScope);
  liveModelPickerSelectionScopeRef.current = modelPickerSelectionScope;
  const isModelPickerSelectionCurrent = useCallback(
    (selectionScope: ModelPickerSelectionScope) =>
      areModelPickerSelectionScopesEqual(liveModelPickerSelectionScopeRef.current, selectionScope),
    []
  );

  const {
    currentMode,
    currentModel,
    currentVariant,
    setCurrentMode,
    setCurrentModel,
    setCurrentVariant,
  } = useSessionConfigSync({
    activeSessionType,
    fetchedData,
    sessionConfig,
    modelOptions,
    selectedModel: sessionModels.selectedValue,
    selectedVariant: sessionModels.selectedVariant,
  });

  const {
    flatListRef,
    handleContentSizeChange,
    handleListLayout,
    handleScroll,
    handleScrollBeginDrag,
    handleScrollEndDrag,
    handleMomentumScrollBegin,
    handleMomentumScrollEnd,
  } = useSessionAutoScroll<StoredMessage>({ itemCount: messages.length, resetKey: sessionId });

  useEffect(() => {
    void manager.switchSession(sessionId);
  }, [sessionId, manager]);

  useEffect(() => {
    if (
      activeSessionType !== 'remote' ||
      remoteModelState.protocol !== 'legacy' ||
      fetchedData?.kiloSessionId !== sessionId ||
      gatewayModelsLoading
    ) {
      return;
    }

    const revalidatedOverride = revalidateLegacyGatewayOverride(remoteModelOverride, gatewayModels);
    if (revalidatedOverride !== remoteModelOverride) {
      manager.setRemoteModelOverride(revalidatedOverride);
    }
  }, [
    activeSessionType,
    fetchedData?.kiloSessionId,
    gatewayModels,
    gatewayModelsLoading,
    manager,
    remoteModelOverride,
    remoteModelState.protocol,
    sessionId,
  ]);

  const lastAssistantIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.info.role === 'assistant') {
        return i;
      }
    }
    return -1;
  }, [messages]);

  const renderItem = useCallback(
    ({ item, index }: { item: StoredMessage; index: number }) => (
      <MessageBubble
        message={item}
        isLastAssistantMessage={index === lastAssistantIndex}
        isSessionStreaming={isStreaming}
        getChildMessages={getChildMessages}
        defaultReasoningExpanded={reasoningDefaultExpanded}
      />
    ),
    [lastAssistantIndex, isStreaming, getChildMessages, reasoningDefaultExpanded]
  );

  const handleStop = useCallback(async () => {
    try {
      await manager.interrupt();
    } catch {
      toast.error('Failed to stop execution');
    }
  }, [manager]);

  const handleModelSelect = useCallback(
    (value: string, variant: string, pickerSelection?: ModelPickerSelection) => {
      if (activeSessionType === 'remote') {
        const selectedOption = pickerSelection?.option;
        const selectedRef = selectedOption?.modelRef;
        const option = selectedRef
          ? modelOptions.find(
              candidate =>
                candidate.overrideSource === selectedOption.overrideSource &&
                candidate.modelRef?.providerID === selectedRef.providerID &&
                candidate.modelRef.modelID === selectedRef.modelID
            )
          : modelOptions.find(candidate => candidate.id === value);
        if (option) {
          manager.setRemoteModelOverride(createRemoteModelOverride(option, variant));
        }
        return;
      }

      setCurrentModel(value);
      setCurrentVariant(variant);
      savePersistedModel(organizationId, { model: value, variant });
      persistServerLastSelected({ model: value, ...(variant ? { variant } : {}) });
    },
    [
      activeSessionType,
      manager,
      modelOptions,
      organizationId,
      persistServerLastSelected,
      savePersistedModel,
      setCurrentModel,
      setCurrentVariant,
    ]
  );

  const shouldShowLoading =
    isLoading ||
    (fetchedData === null && !statusIndicator && !error) ||
    (fetchedData !== null && fetchedData.kiloSessionId !== sessionId);
  const shouldBlockMessages = shouldShowLoading;
  const shouldShowWorkingIndicator = shouldShowAgentWorkingIndicator({
    isStreaming,
    pendingMessageCount: pendingMessages.size,
  });
  const shouldShowFooterWorking = shouldShowFooterWorkingIndicator({
    isAgentWorking: shouldShowWorkingIndicator,
    hasStatusIndicator:
      statusIndicator !== null || (cloudStatus !== null && cloudStatus.type !== 'ready'),
  });

  const emptyStateText = error ?? (statusIndicator ? null : 'No messages yet');

  const title =
    fetchedData?.kiloSessionId === sessionId ? (fetchedData.title ?? 'Session') : 'Session';
  const requiresModel = Boolean(fetchedData?.cloudAgentSessionId);
  const isComposerDisabled =
    isReadOnly ||
    !canSend ||
    shouldShowLoading ||
    Boolean(error) ||
    Boolean(activeQuestion) ||
    (requiresModel && !currentModel);
  const showInteractionCards = activeQuestion ?? activePermission;
  const composerPlaceholder =
    (cloudStatus && COMPOSER_PLACEHOLDERS[cloudStatus.type]) ?? 'Message...';
  const keyboardContainerKind = getSessionKeyboardContainerKind(Platform.OS);

  const handleSend = useCallback(
    async (text: string, attachments?: AgentAttachmentWire) => {
      if (requiresModel && !currentModel) {
        toast.error('Select a model before sending');
        return;
      }
      try {
        await manager.send({
          payload: {
            type: 'prompt',
            prompt: text,
            mode: currentMode,
            model: currentModel,
            variant: currentVariant || undefined,
          },
          ...(supportsAttachments && attachments ? { attachments } : {}),
        });
      } catch {
        toast.error('Failed to send message. Please try again.');
      }
    },
    [manager, currentMode, currentModel, currentVariant, requiresModel, supportsAttachments]
  );

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={title}
        headerRight={
          totalCost > 0 ? (
            <Text className="text-sm text-muted-foreground">${totalCost.toFixed(4)}</Text>
          ) : undefined
        }
      />

      {!isConnected && <ConnectivityBanner />}

      {keyboardContainerKind === 'app-aware-padding' ? (
        <AppAwareKeyboardPaddingView className="flex-1">
          {renderKeyboardBody()}
        </AppAwareKeyboardPaddingView>
      ) : (
        <KeyboardAvoidingView className="flex-1" behavior="padding">
          {renderKeyboardBody()}
        </KeyboardAvoidingView>
      )}

      <View style={{ height: bottom }} className="bg-background" />
    </View>
  );

  function renderKeyboardBody() {
    return (
      <>
        <View className="flex-1">{renderContent()}</View>

        {activeQuestion ? (
          <QuestionCard
            questions={activeQuestion.questions}
            onAnswer={answers => {
              void handleAnswerQuestion(answers);
            }}
            onReject={() => {
              void handleRejectQuestion();
            }}
            isSubmitting={isAnswering}
          />
        ) : null}

        {activePermission ? (
          <PermissionCard
            permission={activePermission.permission}
            patterns={activePermission.patterns}
            metadata={activePermission.metadata}
            onRespond={response => {
              void handleRespondToPermission(response);
            }}
            isSubmitting={isRespondingToPermission}
          />
        ) : null}

        {!showInteractionCards &&
          (isReadOnly && messages.length > 0 ? (
            <View className="border-t border-border bg-secondary px-4 py-3">
              <Text className="text-center text-sm text-muted-foreground">
                This is a read-only session
              </Text>
            </View>
          ) : (
            <>
              <SessionModelNotices
                notices={sessionModels.notices}
                onRetry={() => {
                  manager.retryRemoteModels();
                }}
              />
              <ModelPickerSelectionScopeProvider
                selectionScope={modelPickerSelectionScope}
                isSelectionCurrent={isModelPickerSelectionCurrent}
              >
                <ChatComposer
                  onSend={handleSend}
                  onStop={handleStop}
                  disabled={isComposerDisabled}
                  isStreaming={isStreaming}
                  placeholder={composerPlaceholder}
                  mode={currentMode}
                  onModeChange={setCurrentMode}
                  model={currentModel}
                  variant={currentVariant}
                  modelOptions={modelOptions}
                  onModelSelect={handleModelSelect}
                  organizationId={organizationId}
                  attachmentsEnabled={supportsAttachments}
                />
              </ModelPickerSelectionScopeProvider>
            </>
          ))}
      </>
    );
  }

  function renderContent() {
    if (shouldBlockMessages) {
      return (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" />
          <Text className="mt-3 text-sm text-muted-foreground">Loading session…</Text>
        </View>
      );
    }
    if (messages.length === 0) {
      return (
        <View className="flex-1 items-center justify-center px-6">
          {statusIndicator ? <SessionStatusIndicator indicator={statusIndicator} /> : null}
          {emptyStateText ? (
            <Text
              className={`text-center ${error ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}
            >
              {emptyStateText}
            </Text>
          ) : null}
        </View>
      );
    }
    return (
      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={item => item.info.id}
        renderItem={renderItem}
        onScroll={handleScroll}
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={handleScrollEndDrag}
        onMomentumScrollBegin={handleMomentumScrollBegin}
        onMomentumScrollEnd={handleMomentumScrollEnd}
        onContentSizeChange={handleContentSizeChange}
        onLayout={handleListLayout}
        scrollEventThrottle={16}
        ListFooterComponent={
          <>
            <WorkingIndicator messages={messages} isStreaming={shouldShowFooterWorking} />
            {statusIndicator ? <SessionStatusIndicator indicator={statusIndicator} /> : null}
          </>
        }
        contentContainerClassName="py-2"
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      />
    );
  }
}
