import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useActionSheet } from '@expo/react-native-action-sheet';
import { useQuery } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { toast } from 'sonner-native';

import { InstanceSelector } from '@/components/agents/instance-selector';
import { NewSessionPrompt } from '@/components/agents/new-session-prompt';
import { NewSessionRepositorySection } from '@/components/agents/new-session-repository-section';
import { RemoteSpawnComposer } from '@/components/agents/remote-spawn-composer';
import { useNewSessionCreator } from '@/components/agents/use-new-session-creator';
import { useRemoteSpawnDispatch } from '@/components/agents/use-remote-spawn-dispatch';
import { REMOTE_SPAWN_INSTANCE_DISCONNECTED_NOTE } from '@/lib/remote-submit-outcome';
import { pickAgentAttachments } from '@/components/agents/attachment-picker';
import { type AgentMode } from '@/components/agents/mode-selector';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { ScreenHeader } from '@/components/screen-header';
import {
  getGitHubIntegrationUrl,
  shouldShowGitHubIntegrationPrompt,
} from '@/lib/agent-github-integration';
import { AGENT_ATTACHMENT_MAX_FILES } from '@/lib/agent-attachments/constants';
import { useAgentAttachmentUpload } from '@/lib/agent-attachments/use-agent-attachment-upload';
import { WEB_BASE_URL } from '@/lib/config';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { useAutoSelectModel } from '@/lib/hooks/use-auto-select-model';
import { useModelPreferences } from '@/lib/hooks/use-model-preferences';
import { usePersistedAgentModel } from '@/lib/hooks/use-persisted-agent-model';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { resolveNewSessionSubmitDisabled } from '@/lib/new-session-submit';
import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { shouldShowRunOnSelector } from '@/lib/should-show-run-on-selector';
import { useTRPC } from '@/lib/trpc';
import { settleVoiceInputBeforeSubmit } from '@/lib/voice-input/voice-input-submit';

export default function NewSessionScreen() {
  const colors = useThemeColors();
  const { showActionSheetWithOptions } = useActionSheet();
  const { organizationId } = useLocalSearchParams<{ organizationId?: string }>();

  // ── Selectors state ──────────────────────────────────────────────
  const [mode, setMode] = useState<AgentMode>('code');
  const [model, setModel] = useState('');
  const [variant, setVariant] = useState('');
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

  // Org-scoped new-agent flows are Cloud-Agent only by design: a remote
  // spawn creates a personal CLI session that the org route would not be
  // able to attribute to the flow's organization (mobile's data model
  // only loads CLI sessions on personal routes). Hide the entire
  // "Run on" section when the flow is org-scoped.
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
  const autoSelected = useAutoSelectModel(models, organizationId);
  const attachments = useAgentAttachmentUpload({ organizationId });

  // Apply auto-selected model when the user hasn't picked one yet.
  const hasAppliedAutoSelection = useRef(false);
  if (!hasAppliedAutoSelection.current && autoSelected.model && !model) {
    hasAppliedAutoSelection.current = true;
    setModel(autoSelected.model);
    setVariant(autoSelected.variant);
  }

  // ── Repositories ─────────────────────────────────────────────────
  const trpc = useTRPC();
  const {
    data: repoData,
    isLoading: isLoadingRepos,
    isError: isReposError,
    isRefetching: isRefetchingRepos,
    refetch: refetchRepos,
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

  const showGitHubIntegrationPrompt = shouldShowGitHubIntegrationPrompt({
    isLoadingRepos,
    integrationInstalled: repoData?.integrationInstalled,
    repositoryCount: repoData?.repositories.length,
  });

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

  // ── Remote-instance spawn transport (kilo remote) ────────────────
  // C3b: dispatches the remote submit and owns the outcome -> UX
  // (toast, refetch, selection reset, nav). See
  // `@/components/agents/use-remote-spawn-dispatch` and
  // `@/lib/remote-submit-outcome` for the contract.
  const remoteSpawn = useRemoteSpawnDispatch({
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
    [organizationId, saveModel, persistServerLastSelected]
  );

  const handleOpenGitHubIntegration = useCallback(async () => {
    try {
      await WebBrowser.openAuthSessionAsync(getGitHubIntegrationUrl(WEB_BASE_URL, organizationId));
      await refetchRepos();
    } catch {
      toast.error('Could not open GitHub setup. Please try again.');
    }
  }, [organizationId, refetchRepos]);

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

  // oxlint's `jsx-handler-names` rule requires the value of an
  // `onX`-prefixed prop to start with `handle`. The dispatch hook's
  // stable `onChangeRunOnInstance` reference is a closure over
  // several pieces of state, so wrap the call here.
  const handleRunOnInstanceChange = useCallback(
    (next: InstancePickerInstance | null) => {
      remoteSpawn.onChangeRunOnInstance(next);
    },
    [remoteSpawn]
  );

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="New session" />

      {isRemoteTargetSelected ? (
        <RemoteSpawnComposer
          runOnInstance={runOnInstance}
          instanceList={instanceList}
          isLoadingInstances={isLoadingInstances}
          onChangeRunOnInstance={handleRunOnInstanceChange}
          isSpawningRemote={remoteSpawn.isSpawningRemote}
          isStartDisabled={isStartDisabled}
          onStart={handleStartSession}
        />
      ) : (
        <ScrollView
          className="flex-1"
          contentContainerClassName="flex-grow px-4 pb-8 pt-4"
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          <NewSessionPrompt
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
            voiceInputSettlerRef={voiceInputSettlerRef}
          />

          <NewSessionRepositorySection
            disabled={isCreating}
            isError={isReposError}
            isLoading={isLoadingRepos}
            isRefetching={isRefetchingRepos}
            onChange={setSelectedRepo}
            onOpenGitHubIntegration={() => {
              void handleOpenGitHubIntegration();
            }}
            onRefetch={() => {
              void refetchRepos();
            }}
            repositories={repositories}
            showGitHubIntegrationPrompt={showGitHubIntegrationPrompt}
            value={selectedRepo}
          />

          {showRunOnSelector ? (
            <View className="mt-5">
              <Text className="mb-2 text-sm font-medium text-muted-foreground">Run on</Text>
              <InstanceSelector
                value={runOnInstance}
                instances={instanceList}
                isLoading={isLoadingInstances}
                onChange={handleRunOnInstanceChange}
                disabled={isCreating}
              />
              {remoteSpawn.showInstanceDisconnectedNote ? (
                <Text className="mt-2 text-sm text-muted-foreground">
                  {REMOTE_SPAWN_INSTANCE_DISCONNECTED_NOTE}
                </Text>
              ) : null}
            </View>
          ) : null}

          <Button
            size="lg"
            className="mt-6"
            disabled={isStartDisabled}
            onPress={handleStartSession}
          >
            {isCreating ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <Text>Start session</Text>
            )}
          </Button>
        </ScrollView>
      )}
    </View>
  );
}
