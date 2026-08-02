import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useActionSheet } from '@expo/react-native-action-sheet';
import { useQuery } from '@tanstack/react-query';

import { NewSessionFlowBody } from '@/components/agents/new-session-flow-body';
import { useNewSessionCreator } from '@/components/agents/use-new-session-creator';
import {
  NewSessionModelProvider,
  useNewSessionModelState,
} from '@/components/agents/new-session-model-provider';
import { pickAgentAttachments } from '@/components/agents/attachment-picker';
import { ScreenHeader } from '@/components/screen-header';
import { AGENT_ATTACHMENT_MAX_FILES } from '@/lib/agent-attachments/constants';
import { useAgentAttachmentUpload } from '@/lib/agent-attachments/use-agent-attachment-upload';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { useModelPreferences } from '@/lib/hooks/use-model-preferences';
import { usePersistedAgentModel } from '@/lib/hooks/use-persisted-agent-model';
import { resolveNewSessionSubmitDisabled } from '@/lib/new-session-submit';
import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { shouldShowRunOnSelector } from '@/lib/should-show-run-on-selector';
import { useNewSessionShareRemote } from '@/lib/use-new-session-share-remote';
import { useNewSessionRepos } from '@/lib/use-new-session-repos';
import { useTRPC } from '@/lib/trpc';
import { settleVoiceInputBeforeSubmit } from '@/lib/voice-input/voice-input-submit';
import { type NewSessionFlowMode, resolveNewSessionFlowMode } from '@/lib/new-session-flow-state';

export default function NewSessionScreen() {
  const { organizationId } = useLocalSearchParams<{
    organizationId?: string;
  }>();
  return (
    <NewSessionModelProvider organizationId={organizationId}>
      <NewSessionScreenBody />
    </NewSessionModelProvider>
  );
}
function NewSessionScreenBody() {
  const { mode, setMode, model, setModel, variant, setVariant } = useNewSessionModelState();
  const { showActionSheetWithOptions } = useActionSheet();
  const { organizationId, shareId: shareIdParam } = useLocalSearchParams<{
    organizationId?: string;
    shareId?: string;
  }>();
  const shareId: string | undefined = Array.isArray(shareIdParam) ? shareIdParam[0] : shareIdParam;

  const [selectedRepo, setSelectedRepo] = useState('');
  const [runOnInstance, setRunOnInstance] = useState<InstancePickerInstance | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasPrompt, setHasPrompt] = useState(false);
  const submissionLockRef = useRef(false);
  const voiceInputSettlerRef = useRef<(() => Promise<boolean>) | null>(null);

  const [step, setStep] = useState<1 | 2>(1);
  const flowModeLatchedRef = useRef(false);
  const [flowMode, setFlowMode] = useState<NewSessionFlowMode>('pending');
  const showRunOnSelector = shouldShowRunOnSelector(organizationId);

  const {
    models,
    isLoading: isLoadingModels,
    isError: isModelsError,
    refetch: refetchModels,
  } = useAvailableModels(organizationId);
  const { setLastSelected: persistServerLastSelected } = useModelPreferences(organizationId);
  const { saveModel } = usePersistedAgentModel();
  const attachments = useAgentAttachmentUpload({ organizationId });

  const trpc = useTRPC();
  const {
    repositories,
    view,
    isRetrying,
    openGitHubIntegration: openGitHub,
    refreshReposForceFresh,
  } = useNewSessionRepos({ organizationId });

  // Keep the inline selector and picker list in sync.
  const {
    data: instancesData,
    isFetched: isInstancesFetched,
    isError: isInstancesError,
    isPaused: isInstancesPaused,
    refetch: refetchInstances,
  } = useQuery({
    ...trpc.activeSessions.listInstances.queryOptions(undefined, {
      refetchOnWindowFocus: true,
      staleTime: 5000,
      refetchInterval: flowMode === 'steps' && step === 1 ? 10_000 : false,
    }),
    enabled: showRunOnSelector,
  });
  const instanceList: InstancePickerInstance[] = useMemo(
    () => instancesData?.instances ?? [],
    [instancesData]
  );

  const { createSessionFromDraft, promptRef } = useNewSessionCreator({
    attachments,
    mode,
    model,
    organizationId,
    selectedRepo,
    setIsCreating,
    variant,
  });

  const {
    remoteSpawn,
    handleRunOnInstanceChange,
    isShareStaged: isShareStagedFn,
  } = useNewSessionShareRemote({
    shareId,
    organizationId,
    runOnInstance,
    setRunOnInstance,
    refetchInstances,
    instanceList,
  });

  const handleModelSelect = useCallback(
    (modelId: string, newVariant: string) => {
      setModel(modelId);
      setVariant(newVariant);
      saveModel(organizationId, { model: modelId, variant: newVariant });
      persistServerLastSelected({ model: modelId, ...(newVariant ? { variant: newVariant } : {}) });
    },
    [organizationId, saveModel, persistServerLastSelected, setModel, setVariant]
  );

  function handlePromptChange(text: string) {
    promptRef.current = text;
    const nextHasPrompt = text.trim().length > 0;
    setHasPrompt(current => (current === nextHasPrompt ? current : nextHasPrompt));
  }

  const submitCreate = useCallback(async () => {
    await settleVoiceInputBeforeSubmit({
      lock: submissionLockRef,
      onPendingChange: setIsSubmitting,
      settleVoiceInput: async () => {
        const settleVoiceInput = voiceInputSettlerRef.current;
        if (settleVoiceInput === null) {
          return true;
        }
        const settled = await settleVoiceInput();
        return settled;
      },
      submit: createSessionFromDraft,
    });
  }, [createSessionFromDraft]);

  const { addCandidates } = attachments;
  const handleAddAttachment = useCallback(async () => {
    void addCandidates(await pickAgentAttachments(showActionSheetWithOptions));
  }, [addCandidates, showActionSheetWithOptions]);

  const isRemoteTargetSelected = runOnInstance !== null;
  const isStartDisabled = isRemoteTargetSelected
    ? remoteSpawn.isSpawningRemote
    : resolveNewSessionSubmitDisabled({
        attachmentsHasFailed: attachments.hasFailedAttachments,
        attachmentsIsUploading: attachments.isUploading,
        hasPrompt,
        isCreating,
        isRemoteTargetSelected,
        isSubmitting,
        model,
        selectedRepo,
      });

  const handleStartSession = useCallback(() => {
    if (runOnInstance !== null) {
      remoteSpawn.onStart();
      return;
    }
    void submitCreate();
  }, [remoteSpawn, runOnInstance, submitCreate]);
  const instancesSettled =
    !showRunOnSelector || isInstancesFetched || isInstancesError || isInstancesPaused;
  if (!flowModeLatchedRef.current && instancesSettled) {
    flowModeLatchedRef.current = true;
    const resolved = resolveNewSessionFlowMode({
      instancesSettled,
      instanceCount: instanceList.length,
      isShareStaged: isShareStagedFn(),
    });
    if (resolved !== 'pending') {
      setFlowMode(resolved);
    }
  }

  const handleSelectTarget = useCallback(
    (instance: InstancePickerInstance | null) => {
      handleRunOnInstanceChange(instance);
      setStep(2);
    },
    [handleRunOnInstanceChange]
  );

  useEffect(() => {
    if (flowMode !== 'steps' || step !== 2) {
      return undefined;
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setStep(1);
      return true;
    });
    return () => {
      sub.remove();
    };
  }, [flowMode, step]);

  const instancesLoading = showRunOnSelector && !isInstancesFetched && !isInstancesError;
  const eyebrow = flowMode === 'steps' ? `Step ${step} of 2` : undefined;
  const handleStepBack = () => {
    setStep(1);
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title="New session"
        eyebrow={eyebrow}
        showBackButton={flowMode === 'steps' && step === 2 ? true : undefined}
        onBack={flowMode === 'steps' && step === 2 ? handleStepBack : undefined}
      />
      <NewSessionFlowBody
        flowMode={flowMode}
        step={step}
        runOnInstance={runOnInstance}
        instanceList={instanceList}
        initialPrompt={promptRef.current}
        onSelectTarget={handleSelectTarget}
        configureProps={{
          attachments: attachments.attachments,
          attachmentMax: AGENT_ATTACHMENT_MAX_FILES,
          isCreating,
          isModelsError,
          isLoadingModels,
          mode,
          model,
          variant,
          modelOptions: models,
          initialPrompt: promptRef.current,
          onChangeText: handlePromptChange,
          onModeChange: setMode,
          onModelSelect: handleModelSelect,
          onAddAttachment: () => void handleAddAttachment(),
          onRemoveAttachment: attachments.removeAttachment,
          onRetryAttachment: attachments.retryAttachment,
          onRefetchModels: () => void refetchModels(),
          onPrefillAttachments: addCandidates,
          shareId,
          voiceInputSettlerRef,
          showRunOnSelector,
          runOnInstance,
          instanceList,
          isLoadingInstances: instancesLoading,
          onChangeRunOnInstance: handleRunOnInstanceChange,
          showInstanceDisconnectedNote: remoteSpawn.showInstanceDisconnectedNote,
          view,
          isRetrying,
          onChangeRepo: setSelectedRepo,
          onOpenGitHubIntegration: openGitHub,
          onRefreshRepos: () => void refreshReposForceFresh(),
          repositories,
          selectedRepo,
          isStartDisabled,
          isSpawningRemote: remoteSpawn.isSpawningRemote,
          onStartSession: handleStartSession,
        }}
      />
    </View>
  );
}
