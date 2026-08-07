import { useCallback, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useActionSheet } from '@expo/react-native-action-sheet';
import { useQuery } from '@tanstack/react-query';
import { type RemoteModelOverride } from '@kilocode/cloud-agent-sdk';

import { NewSessionConfigureForm } from '@/components/agents/new-session-configure-form';
import { resolveNewSessionModelView } from '@/components/agents/new-session-model-view';
import { useNewSessionCreator } from '@/components/agents/use-new-session-creator';
import {
  NewSessionModelProvider,
  useNewSessionModelState,
} from '@/components/agents/new-session-model-provider';
import { pickAgentAttachments } from '@/components/agents/attachment-picker';
import { useNewSessionPrefillTargets } from '@/components/agents/use-new-session-prefill';
import { ScreenHeader } from '@/components/screen-header';
import { AGENT_ATTACHMENT_MAX_FILES } from '@/lib/agent-attachments/constants';
import { useAgentAttachmentUpload } from '@/lib/agent-attachments/use-agent-attachment-upload';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { useInstanceModelCatalog } from '@/lib/hooks/use-instance-model-catalog';
import { useModelPreferences } from '@/lib/hooks/use-model-preferences';
import { usePersistedAgentModel } from '@/lib/hooks/use-persisted-agent-model';
import { createRemoteModelOverride } from '@/lib/hooks/use-session-model-options';
import { resolveNewSessionSubmitDisabled } from '@/lib/new-session-submit';
import { type InstancePickerInstance, type ModelPickerSelection } from '@/lib/picker-bridge';
import { shouldShowRunOnSelector } from '@/lib/should-show-run-on-selector';
import { useNewSessionShareRemote } from '@/lib/use-new-session-share-remote';
import { useNewSessionRepos } from '@/lib/use-new-session-repos';
import { useTRPC } from '@/lib/trpc';
import { settleVoiceInputBeforeSubmit } from '@/lib/voice-input/voice-input-submit';

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

  const [runOnInstance, setRunOnInstance] = useState<InstancePickerInstance | null>(null);
  const [remoteOverride, setRemoteOverride] = useState<RemoteModelOverride | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasPrompt, setHasPrompt] = useState(false);
  const submissionLockRef = useRef(false);
  const voiceInputSettlerRef = useRef<(() => Promise<boolean>) | null>(null);

  const showRunOnSelector = shouldShowRunOnSelector(organizationId);

  const {
    models,
    isLoading: isLoadingModels,
    isError: isModelsError,
    refetch: refetchModels,
  } = useAvailableModels(organizationId);
  const instanceCatalog = useInstanceModelCatalog(runOnInstance?.connectionId ?? null);
  const modelView = useMemo(
    () =>
      resolveNewSessionModelView({
        isRemoteTarget: runOnInstance !== null,
        catalog: instanceCatalog.catalog,
        catalogLoading: instanceCatalog.isLoading,
        gatewayModels: models,
        gatewayModelsLoading: isLoadingModels,
        gatewayModel: model,
        gatewayVariant: variant,
        remoteOverride,
      }),
    [
      runOnInstance,
      instanceCatalog.catalog,
      instanceCatalog.isLoading,
      models,
      isLoadingModels,
      model,
      variant,
      remoteOverride,
    ]
  );
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

  const { selectedRepo, setSelectedRepo } = useNewSessionPrefillTargets({
    repositories,
    reposSettled: view === 'repos' && repositories.length > 0,
    models,
    modelsSettled: !isLoadingModels && !isModelsError && models.length > 0,
  });

  // Keep the inline selector and picker list in sync.
  const {
    data: instancesData,
    isLoading: isLoadingInstances,
    refetch: refetchInstances,
  } = useQuery({
    ...trpc.activeSessions.listInstances.queryOptions(undefined, {
      refetchOnWindowFocus: true,
      staleTime: 5000,
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

  const { remoteSpawn, handleRunOnInstanceChange } = useNewSessionShareRemote({
    organizationId,
    runOnInstance,
    setRunOnInstance,
    refetchInstances,
    instanceList,
    promptRef,
    attachments: attachments.attachments,
    selection: modelView.spawnSelection,
  });

  const handleModelSelect = useCallback(
    (modelId: string, newVariant: string, pickerSelection?: ModelPickerSelection) => {
      setRemoteOverride(
        pickerSelection ? createRemoteModelOverride(pickerSelection.option, newVariant) : null
      );
      // A CLI-catalog option id is the opaque `remote-model-N`; its model may
      // not exist on the gateway. Never persist either to the gateway
      // preference.
      if (pickerSelection?.option.overrideSource === 'cli-catalog') {
        return;
      }
      setModel(modelId);
      setVariant(newVariant);
      saveModel(organizationId, { model: modelId, variant: newVariant });
      persistServerLastSelected({ model: modelId, ...(newVariant ? { variant: newVariant } : {}) });
    },
    [organizationId, saveModel, persistServerLastSelected, setModel, setVariant]
  );

  const handleRunOnChange = useCallback(
    (next: InstancePickerInstance | null) => {
      setRemoteOverride(null);
      handleRunOnInstanceChange(next);
    },
    [handleRunOnInstanceChange]
  );

  function handlePromptChange(text: string) {
    promptRef.current = text;
    const nextHasPrompt = text.trim().length > 0;
    setHasPrompt(current => (current === nextHasPrompt ? current : nextHasPrompt));
  }

  const submitWithVoiceSettled = useCallback(async (submit: () => Promise<void>) => {
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
      submit,
    });
  }, []);

  const { addCandidates, removeAttachment, retryAttachment } = attachments;
  const handleAddAttachment = useCallback(async () => {
    void addCandidates(await pickAgentAttachments(showActionSheetWithOptions));
  }, [addCandidates, showActionSheetWithOptions]);

  const handleRemoveAttachment = useCallback(
    (id: string) => {
      removeAttachment(id);
    },
    [removeAttachment]
  );

  const handleRetryAttachment = useCallback(
    (id: string) => {
      retryAttachment(id);
    },
    [retryAttachment]
  );

  const isRemoteTargetSelected = runOnInstance !== null;
  const isStartDisabled = isRemoteTargetSelected
    ? remoteSpawn.isSpawningRemote ||
      isSubmitting ||
      attachments.hasFailedAttachments ||
      modelView.isSelectionUnavailable ||
      instanceCatalog.isLoading
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
      void submitWithVoiceSettled(async () => {
        remoteSpawn.onStart();
        await Promise.resolve();
      });
      return;
    }
    void submitWithVoiceSettled(createSessionFromDraft);
  }, [createSessionFromDraft, remoteSpawn, runOnInstance, submitWithVoiceSettled]);

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="New session" />
      <NewSessionConfigureForm
        attachments={attachments.attachments}
        attachmentMax={AGENT_ATTACHMENT_MAX_FILES}
        isCreating={isCreating}
        isModelsError={isModelsError}
        isLoadingModels={isLoadingModels || instanceCatalog.isLoading}
        mode={mode}
        model={modelView.selectedValue}
        variant={modelView.selectedVariant}
        modelOptions={modelView.options}
        initialPrompt={promptRef.current}
        onChangeText={handlePromptChange}
        onModeChange={setMode}
        onModelSelect={handleModelSelect}
        onAddAttachment={() => void handleAddAttachment()}
        onRemoveAttachment={handleRemoveAttachment}
        onRetryAttachment={handleRetryAttachment}
        onRefetchModels={() => void refetchModels()}
        onPrefillAttachments={addCandidates}
        shareId={shareId}
        voiceInputSettlerRef={voiceInputSettlerRef}
        showRunOnSelector={showRunOnSelector}
        runOnInstance={runOnInstance}
        instanceList={instanceList}
        isLoadingInstances={isLoadingInstances}
        onChangeRunOnInstance={handleRunOnChange}
        showInstanceDisconnectedNote={remoteSpawn.showInstanceDisconnectedNote}
        view={view}
        isRetrying={isRetrying}
        onChangeRepo={setSelectedRepo}
        onOpenGitHubIntegration={openGitHub}
        onRefreshRepos={() => void refreshReposForceFresh()}
        repositories={repositories}
        selectedRepo={selectedRepo}
        isStartDisabled={isStartDisabled}
        isSpawningRemote={remoteSpawn.isSpawningRemote}
        onStartSession={handleStartSession}
      />
    </View>
  );
}
