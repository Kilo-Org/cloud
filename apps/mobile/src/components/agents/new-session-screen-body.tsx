/* eslint-disable max-lines -- The screen body wires the form, draft, model, and provider hooks end-to-end from the thin route. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useActionSheet } from '@expo/react-native-action-sheet';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner-native';
import { type KiloSessionId, type RemoteModelOverride } from '@kilocode/cloud-agent-sdk';

import { NewSessionConfigureForm } from '@/components/agents/new-session-configure-form';
import { resolveNewSessionModelView } from '@/components/agents/new-session-model-view';
import { useNewSessionCreator } from '@/components/agents/use-new-session-creator';
import { useEffectiveAgentProfile } from '@/components/agents/use-effective-agent-profile';
import { lockedModelOption, resolvePinnedAgentModel } from '@/components/agents/mode-normalize';
import { isCloudPrepareRetryableError } from '@/components/agents/mobile-session-manager';
import { useEffectiveProfileCustomModes } from '@/components/agents/use-effective-profile-custom-modes';
import { useNewSessionModelState } from '@/components/agents/new-session-model-provider';
import { pickAgentAttachments } from '@/components/agents/attachment-picker';
import { useNewSessionPrefillTargets } from '@/components/agents/use-new-session-prefill';
import {
  readCloneFromKiloSessionId,
  readCloneSourceTitle,
} from '@/components/agents/new-session-prefill';
import { useContinueCloudCreate } from '@/components/agents/use-continue-cloud-create';
import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { useNewSessionDiscardGuard } from '@/app/(app)/agent-chat/use-new-session-discard-guard';
import { AGENT_ATTACHMENT_MAX_FILES } from '@/lib/agent-attachments/constants';
import {
  type AgentAttachmentCandidate,
  useAgentAttachmentUpload,
} from '@/lib/agent-attachments/use-agent-attachment-upload';
import { useAndroidPendingPickerRecovery } from '@/lib/agent-attachments/use-android-pending-picker-recovery';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useInstanceModelCatalog } from '@/lib/hooks/use-instance-model-catalog';
import { useLaunchFolder } from '@/lib/hooks/use-launch-folder';
import { useModelPreferences } from '@/lib/hooks/use-model-preferences';
import { usePersistedAgentModel } from '@/lib/hooks/use-persisted-agent-model';
import { createRemoteModelOverride } from '@/lib/hooks/use-session-model-options';
import {
  resolveContinueStartDisabled,
  resolveNewSessionStartDisabled,
} from '@/lib/new-session-submit';
import { usePreventRemove } from '@/lib/navigation/prevent-remove';
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

/**
 * Mounted only for the ordinary new-session entry (not the Continue clone
 * entry): the clone form has no composer, so the Android pending-picker
 * recovery must not consume a pending result that belongs to the composer.
 * `useAndroidPendingPickerRecovery` has no `enabled` flag, so a conditional
 * mount is the smallest way to skip it on clone entry.
 */
function AndroidPendingPickerRecovery({
  addCandidates,
}: {
  addCandidates: (candidates: AgentAttachmentCandidate[]) => Promise<void>;
}) {
  useAndroidPendingPickerRecovery({
    surface: 'agent-new',
    sessionId: null,
    addCandidates,
  });
  return null;
}

export function NewSessionScreenBody() {
  const { mode, setMode, model, setModel, variant, setVariant } = useNewSessionModelState();
  const { t } = useTranslation();
  const { showActionSheetWithOptions } = useActionSheet();
  const searchParams = useLocalSearchParams<{
    organizationId?: string;
    shareId?: string;
    cloneFromKiloSessionId?: string;
    cloneSourceTitle?: string;
  }>();
  const organizationId = searchParams.organizationId;
  const shareIdParam = searchParams.shareId;
  const shareId: string | undefined = Array.isArray(shareIdParam) ? shareIdParam[0] : shareIdParam;
  const cloneFromKiloSessionId = readCloneFromKiloSessionId(searchParams);
  const cloneSourceTitle = readCloneSourceTitle(searchParams);
  const isCloneEntry = cloneFromKiloSessionId !== '';

  const [runOnInstance, setRunOnInstance] = useState<InstancePickerInstance | null>(null);
  const [remoteOverride, setRemoteOverride] = useState<RemoteModelOverride | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasPrompt, setHasPrompt] = useState(false);
  // Commit choice for the cloud session: Leave changes (false) is the default.
  const [autoCommit, setAutoCommit] = useState(false);
  // Relative launch folder the folder picker confirmed (`""` = launch directory).
  const [folderPath, setFolderPath] = useLaunchFolder(runOnInstance?.connectionId);
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
  // Clone entry never touches the shared new-session draft: pass an undefined
  // identity so `useFencedDraftLoad` performs no fetch (its entity key is
  // typed non-optional, unlike `useDraftFlushOnBackground` below). The
  // `initialPrompt` below already ignores the draft on clone entry.
  const draftState = useFencedDraftLoad({
    userId: isCloneEntry ? undefined : userId,
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
  // settles. A clone entry has no composer, so it ignores both and starts
  // with no prompt.
  const initialPrompt = isCloneEntry
    ? undefined
    : resolvePrefillOverDraft(sharePrefillText, draftState.settled ? draftState.value : null);

  // Save the new-session draft debounced on every text change, and flush the
  // pending write when the app leaves `active`. The draft's fate on unmount —
  // flush to preserve, or clear after a consumed remote spawn — is owned by
  // `useRemoteSpawnDraftCleanup`.
  useDraftFlushOnBackground(userId, isCloneEntry ? undefined : NEW_SESSION_DRAFT_KEY, false);

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

  // Custom modes and the pinned model come from the effective default profile.
  // The lock applies only to the Cloud Agent target; a remote target keeps the
  // unlocked model view and never sends a gateway pin.
  const { customOptions, profileAgents } = useEffectiveProfileCustomModes(organizationId);
  // Clone entry keeps the source prefill model and an unlocked toolbar: no
  // pinned-agent lock, no gateway pin override.
  const pinned = isCloneEntry ? {} : resolvePinnedAgentModel({ slug: mode, profileAgents });
  const displayModel = pinned.model ?? modelView.selectedValue;
  const displayVariant = pinned.model ? (pinned.variant ?? '') : modelView.selectedVariant;
  const modelOptionsForToolbar =
    pinned.model && !modelView.options.some(option => option.id === pinned.model)
      ? [...modelView.options, lockedModelOption(pinned)]
      : modelView.options;

  const trpc = useTRPC();
  const {
    repositories,
    recents,
    groups,
    isRetrying,
    reposSettled,
    openIntegration,
    refreshReposForceFresh,
  } = useNewSessionRepos({ organizationId });

  const { selectedRepo, setSelectedRepo } = useNewSessionPrefillTargets({
    repositories,
    reposSettled,
    models,
    modelsSettled: !isLoadingModels && !isModelsError && models.length > 0,
  });

  // The picker reports a `platform:fullName` key; resolve it to the full row so
  // the creator can send the platform-specific repository field. The prefill
  // seeds the same platform-qualified key, so no bare-fullName fallback is
  // needed (and one would bind a same-named GitLab/Bitbucket row).
  const selectedRepository = useMemo(() => {
    if (!selectedRepo) {
      return null;
    }
    return (
      repositories.find(
        repository => `${repository.platform}:${repository.fullName}` === selectedRepo
      ) ?? null
    );
  }, [repositories, selectedRepo]);

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
    isFetching: isFetchingInstances,
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
  const { markRemoteSpawnAttempted } = useRemoteSpawnDraftCleanup({
    userId: isCloneEntry ? undefined : userId,
  });

  // A committed remote spawn arms the discard-confirm bypass alongside the
  // draft-clearing marker. The bypass is reset when the spawn settles without
  // navigating (a failed spawn), so an abandon after a failure still confirms.
  const handleSpawnAdmitted = useCallback(() => {
    markRemoteSpawnAttempted();
    skipDiscardGuardRef.current = true;
  }, [markRemoteSpawnAttempted]);

  // Clone entry never touches the shared draft. The inline "Run on" reason is
  // a delivered clone/import failure (or an incapable CLI, derived below) and
  // clears when Run-on changes. The one-shot bypass lets the success replace
  // through the busy leave-lock while back/swipe stays blocked in flight.
  const [cloneImportFailureKey, setCloneImportFailureKey] = useState<string | null>(null);
  const cloneNavigateBypassRef = useRef(false);

  const handleCloneImportFailure = useCallback((key: string) => {
    setCloneImportFailureKey(key);
  }, []);

  const armCloneNavigateBypass = useCallback(() => {
    cloneNavigateBypassRef.current = true;
  }, []);

  const { createSessionFromDraft, promptRef } = useNewSessionCreator({
    attachments,
    mode,
    model: displayModel,
    organizationId,
    onCreated: handleCreated,
    selectedRepository,
    setIsCreating,
    variant: displayVariant,
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
    folderPath,
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
    // Clone entry: the dispatch sends the source id only when the selected
    // CLI advertises `sessionClone`, and surfaces delivered clone/import
    // failures through this inline-reason callback.
    cloneFromKiloSessionId: isCloneEntry ? cloneFromKiloSessionId : null,
    onCloneImportFailure: handleCloneImportFailure,
    onSpawnReady: armCloneNavigateBypass,
  });

  const runCloudCreate = useContinueCloudCreate(organizationId, armCloneNavigateBypass);

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
      setCloneImportFailureKey(null);
      handleRunOnInstanceChange(next);
    },
    [handleRunOnInstanceChange]
  );

  function handlePromptChange(text: string) {
    promptRef.current = text;
    const nextHasPrompt = text.trim().length > 0;
    setHasPrompt(current => (current === nextHasPrompt ? current : nextHasPrompt));
    if (userId && !isCloneEntry) {
      saveDraft(userId, NEW_SESSION_DRAFT_KEY, text);
    }
  }

  // Discard confirm: leaving with a non-empty prompt or unsent uploads asks
  // first. Discard clears the stored draft and the route-owned prompt ref, then
  // releases admitted uploads before the captured navigation action is
  // replayed, so a discarded draft or unclaimed upload can never resurface.
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
    // Release only after the discard is committed (clearDraft succeeded): a
    // failed clear keeps the composer mounted, so the uploads stay recoverable.
    attachments.releaseUnclaimedUploads();
  }, [userId, promptRef, attachments]);

  useNewSessionDiscardGuard({
    dirty: (isCloneEntry ? false : hasPrompt) || attachments.hasUnclaimedAttachments,
    hasUnclaimedAttachments: attachments.hasUnclaimedAttachments,
    onDiscard: handleDiscardDraft,
    skipNextGuardRef: skipDiscardGuardRef,
  });

  // Clone-entry busy leave-lock: while a clone/import is in flight, back and
  // swipe are blocked with no discard alert. The one-shot bypass, armed by the
  // success callbacks right before the replace, lets the success navigation
  // through so back from the new session returns to the source session.
  const navigation = useNavigation();
  const isStarting = runOnInstance !== null ? remoteSpawn.isSpawningRemote : isCreating;
  usePreventRemove(isCloneEntry && isStarting, ({ data }) => {
    if (cloneNavigateBypassRef.current) {
      cloneNavigateBypassRef.current = false;
      navigation.dispatch(data.action);
    }
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

  const { addCandidates, removeAttachment, retryAttachment, moveAttachment, reorderAttachments } =
    attachments;

  const handleAddAttachment = useCallback(async () => {
    void addCandidates(
      await pickAgentAttachments(showActionSheetWithOptions, {
        userId,
        surface: 'agent-new',
        sessionId: null,
      })
    );
  }, [addCandidates, showActionSheetWithOptions, userId]);

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
  const instanceHasSessionClone = runOnInstance?.capabilities?.sessionClone === true;
  // Clone entry: an incapable CLI shows the inline "cannot continue" reason
  // immediately; a delivered clone/import failure overrides it after a Start
  // attempt. Both clear when Run-on changes (see handleRunOnChange).
  const incapableCliSelected = isCloneEntry && runOnInstance !== null && !instanceHasSessionClone;
  let runOnInlineNote: string | null = null;
  if (incapableCliSelected) {
    runOnInlineNote = t('agentChat.newSession.cliCannotContinue');
  } else if (cloneImportFailureKey !== null) {
    runOnInlineNote = t(cloneImportFailureKey);
  }

  function resolveStartDisabled(): boolean {
    if (isCloneEntry) {
      return resolveContinueStartDisabled({
        isCreating,
        isSubmitting,
        isSpawningRemote: remoteSpawn.isSpawningRemote,
        model: isRemoteTargetSelected ? modelView.selectedValue : displayModel,
        selectedRepo,
        selectedRepositoryResolved: selectedRepository !== null,
        isRemoteTargetSelected,
        instanceCatalogLoading: instanceCatalog.isLoading,
        instanceHasSessionClone,
        cloneImportFailureKey,
        isModelUnavailable: modelView.isSelectionUnavailable,
      });
    }
    if (isRemoteTargetSelected) {
      return (
        remoteSpawn.isSpawningRemote ||
        isSubmitting ||
        attachments.hasFailedAttachments ||
        attachments.isUploading ||
        modelView.isSelectionUnavailable ||
        instanceCatalog.isLoading
      );
    }
    return resolveNewSessionStartDisabled({
      attachmentsHasFailed: attachments.hasFailedAttachments,
      attachmentsIsUploading: attachments.isUploading,
      hasPrompt,
      isCreating,
      isRemoteTargetSelected,
      isSubmitting,
      model: displayModel,
      selectedRepo,
      selectedRepositoryResolved: selectedRepository !== null,
      isProfileLoading,
    });
  }

  const isStartDisabled = resolveStartDisabled();

  const handleStartSession = useCallback(() => {
    if (isCloneEntry) {
      if (runOnInstance !== null) {
        // Live CLI import: the dispatch carries the clone source id only when
        // the instance advertises `sessionClone` (fail-closed otherwise).
        remoteSpawn.onStart();
        return;
      }
      // Cloud Agent clone: submit the clone-only prepare with the source id and
      // the form's repo/model/variant; success replaces the form.
      void (async () => {
        setIsCreating(true);
        try {
          await runCloudCreate(
            cloneFromKiloSessionId as KiloSessionId,
            { repository: selectedRepository, model: displayModel, variant: displayVariant },
            mode
          );
        } catch (error) {
          const message =
            isCloudPrepareRetryableError(error) || !(error instanceof Error) || !error.message
              ? i18n.t('agentChat.session.cloneFailedRetry')
              : error.message;
          toast.error(message);
        } finally {
          setIsCreating(false);
        }
      })();
      return;
    }
    if (runOnInstance !== null) {
      void submitWithVoiceSettled(async () => {
        remoteSpawn.onStart();
        await Promise.resolve();
      });
      return;
    }
    void submitWithVoiceSettled(createSessionFromDraft);
  }, [
    isCloneEntry,
    runOnInstance,
    cloneFromKiloSessionId,
    selectedRepository,
    displayModel,
    displayVariant,
    mode,
    runCloudCreate,
    remoteSpawn,
    createSessionFromDraft,
    submitWithVoiceSettled,
  ]);

  return (
    <View className="flex-1 bg-background">
      {!isCloneEntry ? <AndroidPendingPickerRecovery addCandidates={addCandidates} /> : null}
      <ScreenHeader title={isCloneEntry ? t('common.continue') : t('common.newSession')} />
      {isCloneEntry ? (
        <View className="px-4 pt-4">
          <Text className="text-sm text-muted-foreground">
            {t('agentChat.newSession.continueFrom', {
              title: cloneSourceTitle || t('agentChat.session.title'),
            })}
          </Text>
        </View>
      ) : null}
      <NewSessionConfigureForm
        key={promptSeed === 'restore' ? 'draft' : 'empty'}
        attachments={attachments.attachments}
        attachmentMax={AGENT_ATTACHMENT_MAX_FILES}
        isCreating={isCreating}
        isModelsError={isModelsError}
        isLoadingModels={isLoadingModels || (isRemoteTargetSelected && instanceCatalog.isLoading)}
        mode={mode}
        model={isRemoteTargetSelected ? modelView.selectedValue : displayModel}
        variant={isRemoteTargetSelected ? modelView.selectedVariant : displayVariant}
        modelOptions={isRemoteTargetSelected ? modelView.options : modelOptionsForToolbar}
        customOptions={customOptions}
        modelLocked={isRemoteTargetSelected ? false : Boolean(pinned.model)}
        modelLockLabel={isRemoteTargetSelected ? undefined : pinned.agentName}
        initialPrompt={initialPrompt}
        onChangeText={handlePromptChange}
        onModeChange={setMode}
        onModelSelect={handleModelSelect}
        onAddAttachment={() => void handleAddAttachment()}
        onRemoveAttachment={handleRemoveAttachment}
        onRetryAttachment={handleRetryAttachment}
        onMoveAttachment={moveAttachment}
        onReorderAttachments={reorderAttachments}
        onRefetchModels={() => void refetchModels()}
        onPrefillAttachments={addCandidates}
        shareId={shareId}
        voiceInputSettlerRef={voiceInputSettlerRef}
        showRunOnSelector={showRunOnSelector}
        runOnInstance={runOnInstance}
        instanceList={instanceList}
        isLoadingInstances={isLoadingInstances}
        isFetchingInstances={isFetchingInstances}
        onRefreshInstances={() => void refetchInstances()}
        onChangeRunOnInstance={handleRunOnChange}
        showInstanceDisconnectedNote={remoteSpawn.showInstanceDisconnectedNote}
        folderPath={folderPath}
        onChangeFolderPath={setFolderPath}
        runOnInlineNote={runOnInlineNote}
        isCloneEntry={isCloneEntry}
        groups={groups}
        isRetrying={isRetrying}
        onChangeRepo={setSelectedRepo}
        onConnectProvider={openIntegration}
        onRefreshRepos={() => void refreshReposForceFresh()}
        repositories={repositories}
        recents={recents}
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
