import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useActionSheet } from '@expo/react-native-action-sheet';
import { useQuery } from '@tanstack/react-query';

import { NewSessionConfigureForm } from '@/components/agents/new-session-configure-form';
import {
  useFencedDraftLoad,
  useNewSessionCreator,
  useRemoteSpawnDraftCleanup,
} from '@/components/agents/use-new-session-creator';
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
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useModelPreferences } from '@/lib/hooks/use-model-preferences';
import { usePersistedAgentModel } from '@/lib/hooks/use-persisted-agent-model';
import { resolveNewSessionSubmitDisabled } from '@/lib/new-session-submit';
import {
  clearDraft,
  flushDraft,
  NEW_SESSION_DRAFT_KEY,
  resolvePrefillOverDraft,
  saveDraft,
} from '@/lib/persist/drafts';
import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { shouldShowRunOnSelector } from '@/lib/should-show-run-on-selector';
import { peekSharePayload } from '@/lib/share-payload';
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
  const [isCreating, setIsCreating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasPrompt, setHasPrompt] = useState(false);
  const submissionLockRef = useRef(false);
  const voiceInputSettlerRef = useRef<(() => Promise<boolean>) | null>(null);

  const showRunOnSelector = shouldShowRunOnSelector(organizationId);

  // Durable new-session draft. The prompt's `initialPrompt` seeds the
  // uncontrolled input once, so the route resolves the stored draft (and the
  // share prefill) BEFORE mounting the form: a draft must never render first
  // and then be replaced by a late prefill. `undefined` marks the not-settled
  // state so the form stays on the pre-render state while the local load runs.
  const { userId, isLoading: isIdentityLoading } = useCurrentUserId();
  const draftState = useFencedDraftLoad({
    userId,
    isIdentityLoading,
    entityKey: NEW_SESSION_DRAFT_KEY,
  });

  // Share-prefill precedence, resolved once before the prompt mounts. The
  // prompt's own `useSharePrefill` still delivers the shared files and
  // re-applies the same text idempotently.
  const [sharePrefillText] = useState<string | null>(() =>
    shareId ? (peekSharePayload(shareId)?.text ?? null) : null
  );
  const initialPrompt = draftState.settled
    ? resolvePrefillOverDraft(sharePrefillText, draftState.text)
    : undefined;

  // Save the new-session draft debounced on every text change, and flush the
  // pending write when the app leaves `active`. The draft's fate on unmount —
  // flush to preserve, or clear after a consumed remote spawn — is owned by
  // `useRemoteSpawnDraftCleanup`.
  useEffect(() => {
    if (!userId) {
      return undefined;
    }
    const subscription = AppState.addEventListener('change', nextAppState => {
      if (nextAppState !== 'active') {
        void flushDraft(userId, NEW_SESSION_DRAFT_KEY);
      }
    });
    return () => {
      subscription.remove();
    };
  }, [userId]);

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

  // A successful session creation owns clearing the new-session draft; a
  // failure must preserve it for the retry.
  const handleCreated = useCallback(() => {
    if (userId) {
      void clearDraft(userId, NEW_SESSION_DRAFT_KEY);
    }
  }, [userId]);

  // Remote spawn success lives inside the spawn dispatch (it replaces the
  // screen). The route arms the attempt marker only after the dispatch
  // admits the spawn — voice settlement and remote admission already
  // passed — and clears the consumed draft when the screen unmounts. A
  // failed spawn keeps the screen mounted (draft preserved for retry); a
  // blocked admission or cancelled voice submit never arms the marker, so
  // the unmount flush preserves the draft.
  const { markRemoteSpawnAttempted } = useRemoteSpawnDraftCleanup({ userId });

  const { createSessionFromDraft, promptRef } = useNewSessionCreator({
    attachments,
    mode,
    model,
    organizationId,
    onCreated: handleCreated,
    selectedRepo,
    setIsCreating,
    variant,
  });

  // Seed the route-owned prompt state from the restored draft once the load
  // settles: the prompt input notifies the route only on typing, so without
  // this the creator's `promptRef` stays empty and the Start button stays
  // disabled (and a remote start would send an empty prompt). Re-armed
  // whenever the draft leaves the settled state (e.g. an account switch).
  const promptStateSeededRef = useRef(false);
  useEffect(() => {
    if (!draftState.settled) {
      promptStateSeededRef.current = false;
      return;
    }
    if (promptStateSeededRef.current) {
      return;
    }
    promptStateSeededRef.current = true;
    // `hasPrompt` is exactly what `resolveNewSessionPromptForCreate` re-derives
    // on submit, so seeding both from one value keeps the Start gate and the
    // submitted text in agreement.
    const restored = initialPrompt ?? '';
    promptRef.current = restored;
    setHasPrompt(restored.trim().length > 0);
  }, [draftState.settled, initialPrompt, promptRef]);

  const { remoteSpawn, handleRunOnInstanceChange } = useNewSessionShareRemote({
    organizationId,
    runOnInstance,
    setRunOnInstance,
    refetchInstances,
    instanceList,
    promptRef,
    attachments: attachments.attachments,
    // Arms the draft-clearing marker only when the dispatch admits the spawn:
    // a blocked admission or cancelled voice submit never clears the draft.
    onSpawnAdmitted: markRemoteSpawnAttempted,
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
    if (userId) {
      saveDraft(userId, NEW_SESSION_DRAFT_KEY, text);
    }
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
    ? remoteSpawn.isSpawningRemote || isSubmitting || attachments.hasFailedAttachments
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
      {!draftState.settled ? (
        <View className="flex-1" />
      ) : (
        <NewSessionConfigureForm
          attachments={attachments.attachments}
          attachmentMax={AGENT_ATTACHMENT_MAX_FILES}
          isCreating={isCreating}
          isModelsError={isModelsError}
          isLoadingModels={isLoadingModels}
          mode={mode}
          model={model}
          variant={variant}
          modelOptions={models}
          initialPrompt={initialPrompt}
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
          onChangeRunOnInstance={handleRunOnInstanceChange}
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
      )}
    </View>
  );
}
