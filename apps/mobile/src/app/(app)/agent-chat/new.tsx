/* eslint-disable max-lines -- the route coordinates the new-session draft, model selection, and submit lifecycle. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useActionSheet } from '@expo/react-native-action-sheet';
import { useQuery } from '@tanstack/react-query';
import { type RemoteModelOverride } from '@kilocode/cloud-agent-sdk';

import { NewSessionConfigureForm } from '@/components/agents/new-session-configure-form';
import { resolveNewSessionModelView } from '@/components/agents/new-session-model-view';
import { useNewSessionCreator } from '@/components/agents/use-new-session-creator';
import { useEffectiveAgentProfile } from '@/components/agents/use-effective-agent-profile';
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
import { useInstanceModelCatalog } from '@/lib/hooks/use-instance-model-catalog';
import { useModelPreferences } from '@/lib/hooks/use-model-preferences';
import { usePersistedAgentModel } from '@/lib/hooks/use-persisted-agent-model';
import { createRemoteModelOverride } from '@/lib/hooks/use-session-model-options';
import { resolveNewSessionStartDisabled } from '@/lib/new-session-submit';
import {
  clearDraft,
  NEW_SESSION_DRAFT_KEY,
  resolvePrefillOverDraft,
  saveDraft,
} from '@/lib/persist/drafts';
import { useDraftFlushOnBackground } from '@/lib/persist/use-draft-flush';
import { useFencedDraftLoad, useRemoteSpawnDraftCleanup } from '@/lib/persist/use-draft-load';
import { type InstancePickerInstance, type ModelPickerSelection } from '@/lib/picker-bridge';
import { shouldShowRunOnSelector } from '@/lib/should-show-run-on-selector';
import { peekSharePayload } from '@/lib/share-payload';
import { useNewSessionShareRemote } from '@/lib/use-new-session-share-remote';
import { useNewSessionRepos } from '@/lib/use-new-session-repos';
import { useTRPC } from '@/lib/trpc';
import { settleVoiceInputBeforeSubmit } from '@/lib/voice-input/voice-input-submit';

import { useNewSessionDiscardGuard } from './use-new-session-discard-guard';

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
  // Commit choice for the cloud session: Leave changes (false) is the default.
  const [autoCommit, setAutoCommit] = useState(false);
  const submissionLockRef = useRef(false);
  const voiceInputSettlerRef = useRef<(() => Promise<boolean>) | null>(null);
  // Armed right before a successful Start/spawn navigation so the discard
  // confirm is skipped for a leave the user already committed to. The remote
  // spawn path arms it at admission and resets it when the spawn settles
  // without navigating (failure), so an abandon after a failed spawn still
  // confirms.
  const skipDiscardGuardRef = useRef(false);

  const showRunOnSelector = shouldShowRunOnSelector(organizationId);

  // Durable new-session draft. The form mounts immediately — typing must never
  // wait on the `user.getMe` query — and the stored draft settles behind it.
  // The prompt input is uncontrolled, so a stored draft that arrives after
  // mount reaches it only through the remount keyed on `promptSeed` below, and
  // that remount happens only while the user has typed nothing.
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
  // The share prefill is known synchronously and always beats a stored draft,
  // so it seeds the first render; the stored draft only exists once the load
  // settles.
  const initialPrompt = resolvePrefillOverDraft(
    sharePrefillText,
    draftState.settled ? draftState.text : null
  );

  // Save the new-session draft debounced on every text change, and flush the
  // pending write when the app leaves `active`. The draft's fate on unmount —
  // flush to preserve, or clear after a consumed remote spawn — is owned by
  // `useRemoteSpawnDraftCleanup`.
  useDraftFlushOnBackground(userId, NEW_SESSION_DRAFT_KEY, false);

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

  const {
    profile,
    profileId,
    isLoading: isProfileLoading,
    isError: isProfileError,
    refetch: refetchProfile,
  } = useEffectiveAgentProfile(organizationId);

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
  // failure must preserve it for the retry. The success path navigates via
  // `replace`, so arm the discard-confirm bypass here — `onCreated` runs
  // synchronously before the navigation, and the leave must not be
  // intercepted as an abandon.
  const handleCreated = useCallback(() => {
    if (userId) {
      void clearDraft(userId, NEW_SESSION_DRAFT_KEY);
    }
    skipDiscardGuardRef.current = true;
  }, [userId]);

  // Remote spawn success lives inside the spawn dispatch (it replaces the
  // screen). The route arms the attempt marker only after the dispatch
  // admits the spawn — voice settlement and remote admission already
  // passed — and clears the consumed draft when the screen unmounts. A
  // failed spawn keeps the screen mounted (draft preserved for retry); a
  // blocked admission or cancelled voice submit never arms the marker, so
  // the unmount flush preserves the draft.
  const { markRemoteSpawnAttempted } = useRemoteSpawnDraftCleanup({ userId });

  // A committed remote spawn arms the discard-confirm bypass alongside the
  // draft-clearing marker. The bypass is reset when the spawn settles without
  // navigating (a failed spawn), so an abandon after a failure still confirms.
  const handleSpawnAdmitted = useCallback(() => {
    markRemoteSpawnAttempted();
    skipDiscardGuardRef.current = true;
  }, [markRemoteSpawnAttempted]);

  const { createSessionFromDraft, promptRef } = useNewSessionCreator({
    attachments,
    mode,
    model,
    organizationId,
    onCreated: handleCreated,
    selectedRepo,
    setIsCreating,
    variant,
    autoCommit,
    profileId,
  });

  // Seed the route-owned prompt state from the restored draft once the load
  // settles: the prompt input notifies the route only on typing, so without
  // this the creator's `promptRef` stays empty and the Start button stays
  // disabled (and a remote start would send an empty prompt).
  //
  // `pending` → the load has not settled; `settled` → the input already holds
  // the right text (nothing was stored, the user typed first, or the share
  // prefill seeded the first render); `restore` → a stored draft has to reach
  // the uncontrolled input, which only a remount can do. Only `restore`
  // changes the form key, so the settled path never remounts and never
  // destroys typing.
  const [promptSeed, setPromptSeed] = useState<'pending' | 'settled' | 'restore'>('pending');
  useEffect(() => {
    if (!draftState.settled) {
      if (promptSeed !== 'pending') {
        // The identity or entity changed, so the input remounts empty: clear
        // the route-owned prompt state with it, or Start would submit text the
        // user can no longer see.
        promptRef.current = '';
        setHasPrompt(false);
        setPromptSeed('pending');
      }
      return;
    }
    if (promptSeed !== 'pending') {
      return;
    }
    if (promptRef.current !== '' || !initialPrompt) {
      setPromptSeed('settled');
      return;
    }
    // `hasPrompt` is exactly what `resolveNewSessionPromptForCreate` re-derives
    // on submit, so seeding both from one value keeps the Start gate and the
    // submitted text in agreement.
    promptRef.current = initialPrompt;
    setHasPrompt(initialPrompt.trim().length > 0);
    // A share prefill already seeded the first render; only a stored draft
    // needs the remount.
    setPromptSeed(initialPrompt === sharePrefillText ? 'settled' : 'restore');
  }, [draftState.settled, initialPrompt, promptRef, promptSeed, sharePrefillText]);

  const { remoteSpawn, handleRunOnInstanceChange } = useNewSessionShareRemote({
    organizationId,
    mode,
    runOnInstance,
    setRunOnInstance,
    refetchInstances,
    instanceList,
    promptRef,
    attachments: attachments.attachments,
    selection: modelView.spawnSelection,
    // Arms the draft-clearing marker only when the dispatch admits the spawn:
    // a blocked admission or cancelled voice submit never clears the draft.
    onSpawnAdmitted: handleSpawnAdmitted,
    // A committed spawn that settles without navigating (retryable or
    // non-retryable) must re-arm the discard confirm, so an abandon after a
    // failed spawn still asks. A successful spawn replaces the screen before
    // this can run, so the bypass stays armed and the guard consumes it.
    onSpawnFailed: () => {
      skipDiscardGuardRef.current = false;
    },
  });

  const handleModelSelect = useCallback(
    (modelId: string, newVariant: string, pickerSelection?: ModelPickerSelection) => {
      setRemoteOverride(
        pickerSelection ? createRemoteModelOverride(pickerSelection.option, newVariant) : null
      );
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
    if (userId) {
      saveDraft(userId, NEW_SESSION_DRAFT_KEY, text);
    }
  }

  // Discard confirm: leaving with a non-empty prompt asks first. Discard
  // clears the stored draft and the route-owned prompt ref before the captured
  // navigation action is replayed, so a discarded prompt can never resurface.
  const handleDiscardDraft = useCallback(async () => {
    if (userId) {
      const cleared = await clearDraft(userId, NEW_SESSION_DRAFT_KEY);
      if (!cleared) {
        // The stored draft could not be removed: stay on the screen so the
        // guard keeps the draft and toasts instead of navigating away.
        throw new Error('Failed to clear the new-session draft');
      }
    }
    promptRef.current = '';
  }, [userId, promptRef]);

  useNewSessionDiscardGuard({
    dirty: hasPrompt,
    onDiscard: handleDiscardDraft,
    skipNextGuardRef: skipDiscardGuardRef,
  });

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
    : resolveNewSessionStartDisabled({
        attachmentsHasFailed: attachments.hasFailedAttachments,
        attachmentsIsUploading: attachments.isUploading,
        hasPrompt,
        isCreating,
        isRemoteTargetSelected,
        isSubmitting,
        model,
        selectedRepo,
        isProfileLoading,
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
        key={promptSeed === 'restore' ? 'draft' : 'empty'}
        attachments={attachments.attachments}
        attachmentMax={AGENT_ATTACHMENT_MAX_FILES}
        isCreating={isCreating}
        isModelsError={isModelsError}
        isLoadingModels={isLoadingModels || (isRemoteTargetSelected && instanceCatalog.isLoading)}
        mode={mode}
        model={modelView.selectedValue}
        variant={modelView.selectedVariant}
        modelOptions={modelView.options}
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
        onChangeRunOnInstance={handleRunOnChange}
        showInstanceDisconnectedNote={remoteSpawn.showInstanceDisconnectedNote}
        view={view}
        isRetrying={isRetrying}
        onChangeRepo={setSelectedRepo}
        onOpenGitHubIntegration={openGitHub}
        onRefreshRepos={() => void refreshReposForceFresh()}
        repositories={repositories}
        selectedRepo={selectedRepo}
        profile={profile}
        isProfileLoading={isProfileLoading}
        isProfileError={isProfileError}
        onRetryProfile={() => void refetchProfile()}
        autoCommit={autoCommit}
        onAutoCommitChange={setAutoCommit}
        isStartDisabled={isStartDisabled}
        isSpawningRemote={remoteSpawn.isSpawningRemote}
        onStartSession={handleStartSession}
      />
    </View>
  );
}
