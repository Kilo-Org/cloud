import { type Dispatch, type SetStateAction, useCallback, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useActionSheet } from '@expo/react-native-action-sheet';
import { useQuery } from '@tanstack/react-query';

import { NewSessionCloudForm } from '@/components/agents/new-session-cloud-form';
import { RemoteSpawnComposer } from '@/components/agents/remote-spawn-composer';
import { useNewSessionCreator } from '@/components/agents/use-new-session-creator';
import { RemoteSpawnInheritanceProvider } from '@/components/agents/use-remote-spawn-dispatch';
import { pickAgentAttachments } from '@/components/agents/attachment-picker';
import { type AgentMode } from '@/components/agents/mode-selector';
import { ScreenHeader } from '@/components/screen-header';
import { resolveRepositorySectionView } from '@/components/agents/new-session-repository-state';
import { AGENT_ATTACHMENT_MAX_FILES } from '@/lib/agent-attachments/constants';
import { useAgentAttachmentUpload } from '@/lib/agent-attachments/use-agent-attachment-upload';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { useAutoSelectModel } from '@/lib/hooks/use-auto-select-model';
import { useModelPreferences } from '@/lib/hooks/use-model-preferences';
import { usePersistedAgentModel } from '@/lib/hooks/use-persisted-agent-model';
import { isRepositorySectionVisible } from '@/lib/is-repository-section-visible';
import { resolveNewSessionSubmitDisabled } from '@/lib/new-session-submit';
import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { shouldShowRunOnSelector } from '@/lib/should-show-run-on-selector';
import { useNewSessionShareRemote } from '@/lib/use-new-session-share-remote';
import { useGitHubReposRefresh } from '@/lib/use-github-repos-refresh';
import { useTRPC } from '@/lib/trpc';
import { settleVoiceInputBeforeSubmit } from '@/lib/voice-input/voice-input-submit';

/**
 * Outer shell owns picker state and the inheritance Provider so
 * `useNewSessionShareRemote` → `useRemoteSpawnDispatch` (in the inner
 * body) reads mode/model/variant as a true descendant. Provider wrapping
 * only the returned JSX left the hook outside the tree with `{}`.
 *
 * Auto-select also lives here: `setModel`/`setVariant` belong to this
 * component, so the render-phase apply is a same-component update (legal).
 * Doing it in the body after the M1 split was a cross-component setState.
 */
export default function NewSessionScreen() {
  const [mode, setMode] = useState<AgentMode>('code');
  const [model, setModel] = useState('');
  const [variant, setVariant] = useState('');
  const { organizationId } = useLocalSearchParams<{
    organizationId?: string;
  }>();
  // Same query key as the body — React Query dedupes; used only so
  // auto-select can run in the state owner without a cross-component update.
  const { models } = useAvailableModels(organizationId);
  const autoSelected = useAutoSelectModel(models, organizationId);
  const hasAppliedAutoSelection = useRef(false);
  if (!hasAppliedAutoSelection.current && autoSelected.model && !model) {
    hasAppliedAutoSelection.current = true;
    setModel(autoSelected.model);
    setVariant(autoSelected.variant);
  }

  return (
    <RemoteSpawnInheritanceProvider mode={mode} model={model} variant={variant}>
      <NewSessionScreenBody
        mode={mode}
        setMode={setMode}
        model={model}
        setModel={setModel}
        variant={variant}
        setVariant={setVariant}
      />
    </RemoteSpawnInheritanceProvider>
  );
}

type NewSessionScreenBodyProps = {
  mode: AgentMode;
  setMode: Dispatch<SetStateAction<AgentMode>>;
  model: string;
  setModel: Dispatch<SetStateAction<string>>;
  variant: string;
  setVariant: Dispatch<SetStateAction<string>>;
};

function NewSessionScreenBody({
  mode,
  setMode,
  model,
  setModel,
  variant,
  setVariant,
}: NewSessionScreenBodyProps) {
  const { showActionSheetWithOptions } = useActionSheet();
  const { organizationId, shareId: shareIdParam } = useLocalSearchParams<{
    organizationId?: string;
    shareId?: string;
  }>();
  // Param can be string | string[] depending on how the route was opened.
  const shareId: string | undefined = Array.isArray(shareIdParam) ? shareIdParam[0] : shareIdParam;

  // ── Selectors state ──────────────────────────────────────────────
  const [selectedRepo, setSelectedRepo] = useState('');
  // `null` = default Cloud Agent target (the existing path). Any
  // non-null value is a live `kilo remote` instance the user picked.
  // C3b switches the JSX to a reduced composer when this is non-null
  // and routes the submit through `useRemoteSpawnDispatch` instead of
  // the cloud-agent `submitCreate` flow.
  const [runOnInstance, setRunOnInstance] = useState<InstancePickerInstance | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasPrompt, setHasPrompt] = useState(false);
  const submissionLockRef = useRef(false);
  const voiceInputSettlerRef = useRef<(() => Promise<boolean>) | null>(null);

  // Org contexts support CLI instances (org attribution travels with create).
  const showRunOnSelector = shouldShowRunOnSelector(organizationId);

  // ── Models ───────────────────────────────────────────────────────
  const {
    models,
    isLoading: isLoadingModels,
    isError: isModelsError,
    refetch: refetchModels,
  } = useAvailableModels(organizationId);
  const { setLastSelected: persistServerLastSelected } = useModelPreferences(organizationId);
  const { saveModel } = usePersistedAgentModel();
  const attachments = useAgentAttachmentUpload({ organizationId });

  // ── Repositories ─────────────────────────────────────────────────
  const trpc = useTRPC();
  const {
    data: repoData,
    isLoading: isLoadingRepos,
    isError: isReposError,
    isRefetching: isRefetchingRepos,
  } = useQuery(
    organizationId
      ? trpc.organizations.cloudAgentNext.listGitHubRepositories.queryOptions({
          organizationId,
          forceRefresh: false,
        })
      : trpc.cloudAgentNext.listGitHubRepositories.queryOptions({
          forceRefresh: false,
        })
  );

  const { openGitHubIntegration, refreshReposForceFresh, isRefreshingRepos, connectCheckFailed } =
    useGitHubReposRefresh({
      organizationId,
      integrationInstalled: repoData?.integrationInstalled,
    });

  const view = resolveRepositorySectionView({
    isLoading: isLoadingRepos,
    isError: isReposError,
    integrationInstalled: repoData?.integrationInstalled,
    repositoryCount: repoData?.repositories.length ?? 0,
    connectCheckFailed,
  });

  const isRetrying = isRefetchingRepos || isRefreshingRepos;

  const repositories = useMemo(() => {
    if (!repoData?.repositories) {
      return [];
    }
    return (repoData.repositories as { fullName: string; private: boolean }[]).map(r => ({
      fullName: r.fullName,
      isPrivate: r.private,
    }));
  }, [repoData]);

  // "Run on" instance list. Fetched at the screen level (not inside the
  // picker) so the selector's value label and the picker's row list stay
  // in sync without round-tripping through the bridge. The picker ALSO
  // re-queries on focus + polls (per the spec), so this is a soft
  // pre-population, not the source of truth. C3b also reuses the
  // `refetch` for the retryable-spawn-failure recovery path.
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

  // ── Session creator ──────────────────────────────────────────────
  const { createSessionFromDraft, promptRef } = useNewSessionCreator({
    attachments,
    mode,
    model,
    organizationId,
    selectedRepo,
    setIsCreating,
    variant,
  });

  // Share latch + remote spawn + share-aware Run-on (F1/F2). Runs under
  // RemoteSpawnInheritanceProvider so mode/model/variant reach the wire.
  const { remoteSpawn, handleRunOnInstanceChange } = useNewSessionShareRemote({
    shareId,
    organizationId,
    runOnInstance,
    setRunOnInstance,
    refetchInstances,
    instanceList,
  });

  // ── Handlers ─────────────────────────────────────────────────────
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
    // Fire-and-forget: the upload hook owns its own progress + error toasts,
    // and `canCreate` (computed from `attachments.isUploading` /
    // `attachments.hasFailedAttachments`) gates the start-session button.
    void addCandidates(await pickAgentAttachments(showActionSheetWithOptions));
  }, [addCandidates, showActionSheetWithOptions]);

  // Cloud-Agent vs. remote-instance submit safety.
  //
  // - Cloud Agent (`runOnInstance === null`): `isStartDisabled` is the
  //   full pre-C3a canCreate expression, byte-identical to today's
  //   contract — the cloud-agent submit path runs through
  //   `handleStartSession` -> `submitCreate` -> `createSessionFromDraft`.
  //   No change to that branch.
  // - Remote target (`runOnInstance !== null`): the start button is
  //   gated only by `isSpawningRemote` so the user can re-press after
  //   a non-retryable / retryable failure.
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

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="New session" />

      {isRepositorySectionVisible(runOnInstance) ? (
        <NewSessionCloudForm
          attachments={attachments.attachments}
          attachmentMax={AGENT_ATTACHMENT_MAX_FILES}
          isCreating={isCreating}
          isModelsError={isModelsError}
          isLoadingModels={isLoadingModels}
          mode={mode}
          model={model}
          variant={variant}
          modelOptions={models}
          onChangeText={handlePromptChange}
          onModeChange={setMode}
          onModelSelect={handleModelSelect}
          onAddAttachment={() => {
            void handleAddAttachment();
          }}
          onRemoveAttachment={id => {
            attachments.removeAttachment(id);
          }}
          onRetryAttachment={id => {
            attachments.retryAttachment(id);
          }}
          onRefetchModels={() => {
            void refetchModels();
          }}
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
          onOpenGitHubIntegration={() => {
            openGitHubIntegration();
          }}
          onRefreshRepos={() => {
            void refreshReposForceFresh();
          }}
          repositories={repositories}
          selectedRepo={selectedRepo}
          isStartDisabled={isStartDisabled}
          onStartSession={handleStartSession}
        />
      ) : (
        <RemoteSpawnComposer
          runOnInstance={runOnInstance}
          instanceList={instanceList}
          isLoadingInstances={isLoadingInstances}
          onChangeRunOnInstance={handleRunOnInstanceChange}
          isSpawningRemote={remoteSpawn.isSpawningRemote}
          isStartDisabled={isStartDisabled}
          onStart={handleStartSession}
        />
      )}
    </View>
  );
}
