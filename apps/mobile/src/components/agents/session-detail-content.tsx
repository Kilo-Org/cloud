/* eslint-disable max-lines -- Session orchestration and its render paths are kept together. */
import { type CloudStatus, type KiloSessionId, type StoredMessage } from 'cloud-agent-sdk';
import { type Href, useRouter } from 'expo-router';
import { useAtomValue } from 'jotai';
import { MessageSquare } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';

import { getBlockingInteraction } from '@/components/agents/agent-interaction-policy';
import { ChatComposer } from '@/components/agents/chat-composer';
import { ConnectivityBanner } from '@/components/agents/connectivity-banner';
import { MessageBubble } from '@/components/agents/message-bubble';
import { ModelPickerSelectionScopeProvider } from '@/components/agents/model-selector';
import { PermissionCard } from '@/components/agents/permission-card';
import { QuestionCard } from '@/components/agents/question-card';
import { getSessionKeyboardContainerKind } from '@/components/agents/session-keyboard-container-state';
import {
  type ContextSheetIdentity,
  getContextSheetMountState,
} from '@/components/agents/context-usage-display';
import {
  SessionContextCostFallback,
  SessionContextMetrics,
} from '@/components/agents/session-context-metrics';
import { SessionContextSheet } from '@/components/agents/session-context-sheet';
import { useSessionManager } from '@/components/agents/session-provider';
import { SessionStatusIndicator } from '@/components/agents/session-status-indicator';
import {
  shouldShowAgentWorkingIndicator,
  shouldShowFooterWorkingIndicator,
} from '@/components/agents/session-working-state';
import { EmptyState } from '@/components/empty-state';
import { AppAwareKeyboardPaddingView } from '@/components/kilo-chat/app-aware-keyboard-padding';
import {
  resolveLoadedCliSessionPresenceId,
  useCliSessionPresence,
} from '@/components/kilo-chat/hooks/use-cli-session-presence';
import { useInteractionHandlers } from '@/components/agents/use-interaction-handlers';
import { useSessionAutoScroll } from '@/components/agents/use-session-auto-scroll';
import { useSessionConfigSync } from '@/components/agents/use-session-config-sync';
import { WorkingIndicator } from '@/components/agents/working-indicator';
import { ChildSessionSheet } from '@/components/agents/child-session-sheet';
import { PartRenderer } from '@/components/agents/part-renderer';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { type AgentAttachmentWire } from '@/lib/agent-attachments/use-agent-attachment-upload';
import {
  type AnalyticsSurface,
  captureEvent,
  MESSAGE_SENT_EVENT,
  SESSION_VIEWED_EVENT,
} from '@/lib/analytics/posthog';
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
import { resolveSessionContextInfo } from '@/lib/session-context-info';
import {
  areModelPickerSelectionScopesEqual,
  type ModelPickerSelection,
  type ModelPickerSelectionScope,
} from '@/lib/picker-bridge';
import { cn } from '@/lib/utils';

type SessionDetailContentProps = {
  sessionId: KiloSessionId;
  openedVia?: 'push' | 'app';
};

const COMPOSER_PLACEHOLDERS: Partial<Record<CloudStatus['type'], string>> = {
  preparing: 'Setting up environment...',
  finalizing: 'Wrapping up...',
};

export function SessionDetailContent({
  sessionId,
  openedVia = 'app',
}: Readonly<SessionDetailContentProps>) {
  const manager = useSessionManager();
  const router = useRouter();
  const [childSession, setChildSession] = useState<{
    sessionId: KiloSessionId;
    title: string;
  }>();

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
  const getChildSessionHydrationState = useAtomValue(manager.atoms.childSessionHydrationState);
  const pendingMessages = useAtomValue(manager.atoms.pendingMessages);
  const activeSessionType = useAtomValue(manager.atoms.activeSessionType);
  const remoteModelState = useAtomValue(manager.atoms.remoteModelState);
  const observedModel = useAtomValue(manager.atoms.observedModel);
  const remoteModelOverride = useAtomValue(manager.atoms.remoteModelOverride);
  const contextUsage = useAtomValue(manager.atoms.contextUsage);
  const [openContextSheetIdentity, setOpenContextSheetIdentity] =
    useState<ContextSheetIdentity | null>(null);

  const { isConnected } = useAppLifecycle();
  const { bottom } = useSafeAreaInsets();

  const analyticsSurface: AnalyticsSurface = fetchedData?.cloudAgentSessionId
    ? 'cloud-agent'
    : 'remote-session';

  const {
    isAnswering,
    isRespondingToPermission,
    handleAnswerQuestion,
    handleRejectQuestion,
    handleRespondToPermission,
  } = useInteractionHandlers({
    manager,
    activeQuestion,
    activePermission,
    surface: analyticsSurface,
  });

  const organizationId = fetchedData?.organizationId ?? undefined;

  const presenceSessionId = resolveLoadedCliSessionPresenceId(
    sessionId,
    fetchedData?.kiloSessionId
  );
  useCliSessionPresence(presenceSessionId);

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
  const contextInfo = useMemo(
    () => resolveSessionContextInfo(contextUsage, sessionModels.options),
    [contextUsage, sessionModels.options]
  );
  const contextModelAndProvider = useMemo(() => {
    if (!contextInfo) {
      return { model: '', provider: '' };
    }
    const match = sessionModels.options.find(
      option =>
        (option.modelRef?.providerID === contextInfo.providerID &&
          option.modelRef.modelID === contextInfo.modelID) ||
        (contextInfo.providerID === 'kilo' &&
          option.showGatewayMetadata &&
          option.id === contextInfo.modelID)
    );
    return {
      model: match?.name ?? match?.displayId ?? contextInfo.modelID,
      provider:
        match?.provider?.name ??
        (contextInfo.providerID === 'kilo' ? 'Kilo' : contextInfo.providerID),
    };
  }, [contextInfo, sessionModels.options]);
  const headerRight = contextInfo ? (
    <SessionContextMetrics
      info={contextInfo}
      totalCost={totalCost}
      onPress={() => {
        setOpenContextSheetIdentity({
          sessionId,
          providerID: contextInfo.providerID,
          modelID: contextInfo.modelID,
        });
      }}
    />
  ) : (
    <SessionContextCostFallback totalCost={totalCost} />
  );
  const sheetMountState = getContextSheetMountState(
    contextInfo,
    openContextSheetIdentity,
    sessionId
  );
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

  const viewTrackedRef = useRef<string | null>(null);
  useEffect(() => {
    if (fetchedData?.kiloSessionId !== sessionId || viewTrackedRef.current === sessionId) {
      return;
    }
    viewTrackedRef.current = sessionId;
    captureEvent(SESSION_VIEWED_EVENT, { surface: analyticsSurface, via: openedVia });
  }, [fetchedData, sessionId, analyticsSurface, openedVia]);

  useEffect(() => {
    void manager.switchSession(sessionId);
  }, [sessionId, manager]);

  useEffect(() => {
    setOpenContextSheetIdentity(openIdentity => {
      if (
        !openIdentity ||
        (contextInfo &&
          openIdentity.sessionId === sessionId &&
          openIdentity.providerID === contextInfo.providerID &&
          openIdentity.modelID === contextInfo.modelID)
      ) {
        return openIdentity;
      }
      return null;
    });
  }, [contextInfo, sessionId]);

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

  const handleOpenChildSession = useCallback(
    (childSessionId: KiloSessionId, childTitle: string) => {
      setChildSession({ sessionId: childSessionId, title: childTitle });
      void manager.hydrateChildSession(childSessionId);
    },
    [manager]
  );

  const renderItem = useCallback(
    ({ item, index }: { item: StoredMessage; index: number }) => (
      <MessageBubble
        message={item}
        isLastAssistantMessage={index === lastAssistantIndex}
        isSessionStreaming={isStreaming}
        getChildMessages={getChildMessages}
        defaultReasoningExpanded={reasoningDefaultExpanded}
        onOpenChildSession={handleOpenChildSession}
      />
    ),
    [
      lastAssistantIndex,
      isStreaming,
      getChildMessages,
      reasoningDefaultExpanded,
      handleOpenChildSession,
    ]
  );

  const handleStop = useCallback(async () => {
    try {
      await manager.interrupt();
    } catch {
      toast.error('Failed to stop execution');
    }
  }, [manager]);

  const handleBackToSessions = useCallback(() => {
    router.replace('/(app)/(tabs)/(2_agents)' as Href);
  }, [router]);

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

  const emptyStateText = statusIndicator ? null : 'No messages yet';

  const title =
    fetchedData?.kiloSessionId === sessionId ? (fetchedData.title ?? 'Session') : 'Session';
  const requiresModel = Boolean(fetchedData?.cloudAgentSessionId);
  const blockingInteraction = getBlockingInteraction({ activeQuestion, activePermission });
  const hasBlockingInteraction = blockingInteraction !== 'none';
  const isComposerDisabled =
    isReadOnly ||
    !canSend ||
    shouldShowLoading ||
    Boolean(error) ||
    hasBlockingInteraction ||
    (requiresModel && !currentModel);
  const composerPlaceholder =
    (cloudStatus && COMPOSER_PLACEHOLDERS[cloudStatus.type]) ?? 'Message...';
  const keyboardContainerKind = getSessionKeyboardContainerKind(Platform.OS);

  const handleSend = useCallback(
    async (text: string, attachments?: AgentAttachmentWire) => {
      if (requiresModel && !currentModel) {
        toast.error('Select a model before sending');
        return;
      }
      // manager.send() reports failures via its own return value (and toasts
      // through the manager's onSendFailed hook) rather than rejecting — it
      // is the single toast owner for send failures. Throw here, without a
      // second toast, purely so the composer's `await onSend(...)` sees the
      // rejection and preserves the draft.
      const sent = await manager.send({
        payload: {
          type: 'prompt',
          prompt: text,
          mode: currentMode,
          model: currentModel,
          variant: currentVariant || undefined,
        },
        ...(supportsAttachments && attachments ? { attachments } : {}),
      });
      if (!sent) {
        throw new Error('Failed to send message');
      }
      captureEvent(MESSAGE_SENT_EVENT, { surface: analyticsSurface });
    },
    [
      manager,
      currentMode,
      currentModel,
      currentVariant,
      requiresModel,
      supportsAttachments,
      analyticsSurface,
    ]
  );

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={title} headerRight={headerRight} />

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

      {sheetMountState.mounted ? (
        <SessionContextSheet
          visible={sheetMountState.visible}
          info={sheetMountState.info}
          modelDisplay={contextModelAndProvider.model}
          providerDisplay={contextModelAndProvider.provider}
          totalCost={totalCost}
          onClose={() => {
            setOpenContextSheetIdentity(null);
          }}
        />
      ) : null}

      {childSession ? (
        <ChildSessionSheet
          sessionId={childSession.sessionId}
          title={childSession.title}
          getChildMessages={getChildMessages}
          hydrationState={getChildSessionHydrationState(childSession.sessionId)}
          renderPart={props => <PartRenderer {...props} />}
          onOpenChildSession={handleOpenChildSession}
          onRetry={() => {
            void manager.hydrateChildSession(childSession.sessionId);
          }}
          onClose={() => {
            setChildSession(undefined);
          }}
        />
      ) : null}
    </View>
  );

  function renderKeyboardBody() {
    return (
      <>
        <View className="flex-1">{renderContent()}</View>

        {blockingInteraction === 'question' && activeQuestion ? (
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

        {blockingInteraction === 'permission' && activePermission ? (
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

        {isReadOnly && messages.length > 0 && !hasBlockingInteraction ? (
          <View className="border-t border-border bg-secondary px-4 py-3">
            <Text className="text-center text-sm text-muted-foreground">
              This is a read-only session
            </Text>
          </View>
        ) : null}

        {!isReadOnly || messages.length === 0 ? (
          <View
            className={cn(hasBlockingInteraction && 'hidden')}
            accessibilityElementsHidden={hasBlockingInteraction}
            importantForAccessibility={hasBlockingInteraction ? 'no-hide-descendants' : 'auto'}
          >
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
          </View>
        ) : null}
      </>
    );
  }

  function renderContent() {
    if (shouldBlockMessages) {
      return <SessionSkeletonMessages />;
    }
    if (error && messages.length === 0) {
      return (
        <View className="flex-1 items-center justify-center gap-3 px-6">
          <QueryError
            variant="server"
            placement="top"
            className="px-0 pt-0"
            title="Couldn't load this session"
            message={error}
            onRetry={() => {
              void manager.switchSession(sessionId);
            }}
          />
          <Button variant="ghost" onPress={handleBackToSessions}>
            <Text>Back to sessions</Text>
          </Button>
        </View>
      );
    }
    if (messages.length === 0) {
      return (
        <View className="flex-1 items-center justify-center px-6">
          {statusIndicator ? <SessionStatusIndicator indicator={statusIndicator} /> : null}
          {emptyStateText ? (
            <EmptyState
              icon={MessageSquare}
              title={emptyStateText}
              description="Send a message below to get started."
            />
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

// Mirrors MessageBubble's bubble geometry (px-4 py-1/py-2 wrapper,
// rounded-2xl with an asymmetric "tail" corner, self-start/self-end
// alignment) so the loading state reads as a message list, not a spinner.
export function SessionSkeletonMessages() {
  return (
    <View className="flex-1 pt-2">
      <View className="items-start px-4 py-2">
        <Skeleton className="h-16 w-3/4 rounded-2xl rounded-tl-sm" />
      </View>
      <View className="items-end px-4 py-1">
        <Skeleton className="h-10 w-1/2 rounded-2xl rounded-tr-sm" />
      </View>
      <View className="items-start px-4 py-2">
        <Skeleton className="h-24 w-2/3 rounded-2xl rounded-tl-sm" />
      </View>
    </View>
  );
}
