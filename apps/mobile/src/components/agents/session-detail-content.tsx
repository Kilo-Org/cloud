import { type CloudStatus, type KiloSessionId, type StoredMessage } from 'cloud-agent-sdk';
import { useAtomValue } from 'jotai';
import { useCallback, useEffect, useMemo } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';

import { ChatComposer } from '@/components/agents/chat-composer';
import { ConnectivityBanner } from '@/components/agents/connectivity-banner';
import { MessageBubble } from '@/components/agents/message-bubble';
import { PermissionCard } from '@/components/agents/permission-card';
import { QuestionCard } from '@/components/agents/question-card';
import { useSessionManager } from '@/components/agents/session-provider';
import { SessionStatusIndicator } from '@/components/agents/session-status-indicator';
import { useInteractionHandlers } from '@/components/agents/use-interaction-handlers';
import { useSessionAutoScroll } from '@/components/agents/use-session-auto-scroll';
import { useSessionConfigSync } from '@/components/agents/use-session-config-sync';
import { WorkingIndicator } from '@/components/agents/working-indicator';
import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { useAppLifecycle } from '@/lib/hooks/use-app-lifecycle';
import { useAvailableModels } from '@/lib/hooks/use-available-models';

type SessionDetailContentProps = {
  sessionId: KiloSessionId;
};

function getComposerPlaceholder(cloudStatusType: CloudStatus['type'] | undefined) {
  if (cloudStatusType === 'preparing') {
    return 'Setting up environment...';
  }

  if (cloudStatusType === 'finalizing') {
    return 'Wrapping up...';
  }

  return 'Message...';
}

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
  const activeQuestion = useAtomValue(manager.atoms.activeQuestion);
  const activePermission = useAtomValue(manager.atoms.activePermission);
  const totalCost = useAtomValue(manager.atoms.totalCost);
  const getChildMessages = useAtomValue(manager.atoms.childMessages);

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

  const { models: modelOptions } = useAvailableModels(organizationId);

  const {
    currentMode,
    currentModel,
    currentVariant,
    setCurrentMode,
    setCurrentModel,
    setCurrentVariant,
  } = useSessionConfigSync({ fetchedData, sessionConfig, modelOptions });

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
      />
    ),
    [lastAssistantIndex, isStreaming, getChildMessages]
  );

  const handleStop = useCallback(async () => {
    try {
      await manager.interrupt();
    } catch {
      toast.error('Failed to stop execution');
    }
  }, [manager]);

  const shouldShowLoading =
    isLoading ||
    (fetchedData === null && !statusIndicator && !error) ||
    (fetchedData !== null && fetchedData.kiloSessionId !== sessionId);
  const shouldBlockMessages = shouldShowLoading;

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
  const composerPlaceholder = getComposerPlaceholder(cloudStatus?.type);

  const handleSend = useCallback(
    async (text: string) => {
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
        });
      } catch {
        toast.error('Failed to send message. Please try again.');
      }
    },
    [manager, currentMode, currentModel, currentVariant, requiresModel]
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

      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
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
              onModelSelect={(modelId, newVariant) => {
                setCurrentModel(modelId);
                setCurrentVariant(newVariant);
              }}
            />
          ))}
      </KeyboardAvoidingView>

      <View style={{ height: bottom }} className="bg-background" />
    </View>
  );

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
            <WorkingIndicator messages={messages} isStreaming={isStreaming} />
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
