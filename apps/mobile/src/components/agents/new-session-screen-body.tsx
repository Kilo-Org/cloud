/* eslint-disable max-lines -- The screen body wires the form, draft, model, and provider hooks end-to-end from the thin route. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { type Href, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useActionSheet } from '@expo/react-native-action-sheet';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';
import { type KiloSessionId, type RemoteModelOverride } from '@kilocode/cloud-agent-sdk';

import { NewSessionConfigureForm } from '@/components/agents/new-session-configure-form';
import { resetSelectedBranchOverrides } from '@/components/agents/new-session-repository-state';
import { resolveNewSessionModelView } from '@/components/agents/new-session-model-view';
import {
  type NewSessionPromptSeed,
  resolveNewSessionPromptSeedDecision,
} from '@/components/agents/new-session-prompt-seed';
import {
  type CloudCreateFailure,
  useNewSessionCreator,
} from '@/components/agents/use-new-session-creator';
import { useEffectiveAgentProfile } from '@/components/agents/use-effective-agent-profile';
import {
  type AgentMode,
  dedupeCustomModeOptions,
  isBuiltinAgentMode,
  lockedModelOption,
  mergeProfileAndRuntimeModeOptions,
  resolvePinnedAgentModel,
} from '@/components/agents/mode-normalize';
import { cloudPrepareFailureMessage } from '@/components/agents/cloud-prepare-error-display';
import { isCloudPrepareRetryableError } from '@/components/agents/mobile-session-manager';
import { useEffectiveProfileCustomModes } from '@/components/agents/use-effective-profile-custom-modes';
import { useNewSessionModelState } from '@/components/agents/new-session-model-provider';
import { stripInlineCodeMarkers } from '@/i18n/plain-copy';
import { pickAgentAttachments } from '@/components/agents/attachment-picker';
import {
  useNewSessionPrefill,
  useNewSessionPrefillTargets,
} from '@/components/agents/use-new-session-prefill';
import {
  readCloneFromKiloSessionId,
  readCloneSourceTitle,
  readCloneUpToMessageId,
  readForkPrefillText,
  readForkSourceIsCloudAgent,
} from '@/components/agents/new-session-prefill';
import { useNewSessionOrganization } from '@/components/agents/use-new-session-organization';
import { useContinueCloudCreate } from '@/components/agents/use-continue-cloud-create';
import { type VariableEdit } from '@/components/profiles/profile-variables-model';
import { ContextControl } from '@/components/context-control';
import { ScreenHeader } from '@/components/screen-header';
import { SaveDraftAsTodoSheet } from '@/components/todos/save-draft-as-todo-sheet';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { useStackSafeReplace } from '@/lib/navigation/stack-safe-replace';
import { useNewSessionDiscardGuard } from '@/components/agents/use-new-session-discard-guard';
import { AGENT_ATTACHMENT_MAX_FILES } from '@/lib/agent-attachments/constants';
import {
  type AgentAttachmentCandidate,
  useAgentAttachmentUpload,
} from '@/lib/agent-attachments/use-agent-attachment-upload';
import { useAndroidPendingPickerRecovery } from '@/lib/agent-attachments/use-android-pending-picker-recovery';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { useCliAgents } from '@/lib/hooks/use-cli-agents';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useInstanceModelCatalog } from '@/lib/hooks/use-instance-model-catalog';
import { useLaunchFolder } from '@/lib/hooks/use-launch-folder';
import { useModelPreferences } from '@/lib/hooks/use-model-preferences';
import { usePersistedAgentModel } from '@/lib/hooks/use-persisted-agent-model';
import { usePersistedRunOnDestination } from '@/lib/hooks/use-persisted-run-on-destination';
import { useThemedActionSheetOptions } from '@/lib/hooks/use-themed-action-sheet';
import { createRemoteModelOverride } from '@/lib/hooks/use-session-model-options';
import {
  FORK_CUT_NOT_SYNCED_KEY,
  resolveCloneCapabilityRefusal,
} from '@/lib/hooks/remote-instance-spawn-classifier';
import {
  resolveContinueStartDisabled,
  resolveNewSessionStartBlockedReason,
  resolveNewSessionStartDisabled,
} from '@/lib/new-session-submit';
import { usePreventRemove } from '@/lib/navigation/prevent-remove';
import { getRepoBindingsPath } from '@/lib/profile-agent-navigation';
import {
  clearDraft,
  flushDraft,
  NEW_SESSION_DRAFT_KEY,
  resolvePrefillOverDraft,
  saveDraft,
} from '@/lib/persist/drafts';
import { useDraftFlushOnBackground } from '@/lib/persist/use-draft-flush';
import { useFencedDraftLoad, useRemoteSpawnDraftCleanup } from '@/lib/persist/use-draft-load';
import { type InstancePickerInstance, type ModelPickerSelection } from '@/lib/picker-bridge';
import { profilePickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';
import {
  PRESELECT_CLOUD_RUN_ON,
  PRESELECT_COMPUTER_RUN_ON,
  readPreselectRunOn,
  resolvePersistedRunOn,
  shouldRestorePersistedRunOn,
} from '@/lib/run-on-destination';
import { shouldShowRunOnSelector } from '@/lib/should-show-run-on-selector';
import { peekSharePayload } from '@/lib/share-payload';
import { sessionDisplayTitle } from '@/lib/session-display-title';
import { useNewSessionShareRemote } from '@/lib/use-new-session-share-remote';
import { useNewSessionRepos } from '@/lib/use-new-session-repos';
import { linkStartedTodoSession } from '@/lib/hooks/todo-session-link';
import { useTRPC } from '@/lib/trpc';
import { settleVoiceInputBeforeSubmit } from '@/lib/voice-input/voice-input-submit';

/** The ingest rejection code for a fork cut missing from the cloud source. */
const CLONE_CUT_NOT_FOUND_CODE = 'clone_cut_not_found';

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
  const router = useRouter();
  const themedSheet = useThemedActionSheetOptions();
  const { showActionSheetWithOptions } = useActionSheet();
  const searchParams = useLocalSearchParams<{
    organizationId?: string;
    shareId?: string;
    cloneFromKiloSessionId?: string;
    cloneSourceTitle?: string;
    cloneUpToMessageId?: string;
    forkPrefillText?: string;
    forkSourceIsCloudAgent?: string;
    preselectRunOn?: string;
  }>();
  const { organizationId, isCloneEntry } = useNewSessionOrganization();
  const shareIdParam = searchParams.shareId;
  const shareId: string | undefined = Array.isArray(shareIdParam) ? shareIdParam[0] : shareIdParam;
  const cloneFromKiloSessionId = readCloneFromKiloSessionId(searchParams);
  const cloneSourceTitle = readCloneSourceTitle(searchParams);
  // "Fork from here": the inclusive cut, and a forked user message's text for
  // the new session's composer. Both empty for a full Continue.
  const cloneUpToMessageId = isCloneEntry ? readCloneUpToMessageId(searchParams) : '';
  const forkPrefillText = cloneUpToMessageId ? readForkPrefillText(searchParams) : '';
  const forkSourceIsCloudAgent =
    cloneUpToMessageId !== '' && readForkSourceIsCloudAgent(searchParams);
  // The route's explicit Run-on preselection: the tour's cloud path names the
  // Cloud Agent sentinel, the computer path names the computer sentinel, and
  // an in-app computer entry names the tapped connection id.
  const preselectRunOn = readPreselectRunOn(searchParams.preselectRunOn);
  const preselectConnectionId =
    preselectRunOn !== null &&
    preselectRunOn !== PRESELECT_CLOUD_RUN_ON &&
    preselectRunOn !== PRESELECT_COMPUTER_RUN_ON
      ? preselectRunOn
      : null;
  // The tour's computer path: the computer target is selected from the first
  // frame; the restore effect below binds the first connected computer.
  const preselectComputer = preselectRunOn === PRESELECT_COMPUTER_RUN_ON;

  const [runOnInstance, setRunOnInstance] = useState<InstancePickerInstance | null>(null);
  // The computer target selected with no instance bound yet (the tour's
  // computer path, before the instance list resolves a computer or while none
  // is connected). Cleared only by an explicit in-form pick of Cloud Agent;
  // the route param never re-arms it.
  const [computerTargetSelected, setComputerTargetSelected] = useState(preselectComputer);
  const [remoteOverride, setRemoteOverride] = useState<RemoteModelOverride | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // The last cloud-create rejection. The form renders it inline so a failed
  // Start is never a silent no-op; a retryable one keeps the Retry control.
  const [cloudCreateError, setCloudCreateError] = useState<CloudCreateFailure | null>(null);
  const [hasPrompt, setHasPrompt] = useState(false);
  // The profile picked for THIS session; null keeps the effective default.
  const [overrideProfileId, setOverrideProfileId] = useState<string | null>(null);
  // The manual env vars and setup commands typed under Advanced Configuration.
  // Owned here (not by the panel) so the create body carries them even when the
  // user starts without saving a profile.
  const [manualVars, setManualVars] = useState<VariableEdit[]>([]);
  const [manualCommands, setManualCommands] = useState<string[]>([]);
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
  const runOnRestoredRef = useRef(false);
  const runOnUserPickedRef = useRef(false);

  const showRunOnSelector = shouldShowRunOnSelector(organizationId);

  // Durable new-session draft. The form mounts immediately — typing must never
  // wait on the `user.getMe` query — and the stored draft settles behind it.
  // The prompt input is uncontrolled, so a stored draft that arrives after
  // mount reaches it only through the remount keyed on `promptSeed` below, and
  // that remount happens only while the user has typed nothing.
  const { userId, isLoading: isIdentityLoading } = useCurrentUserId();

  // The Organization section above Run on. The account it names is the one the
  // create is attributed to and every org-scoped pick reads
  // (`useNewSessionOrganization`): an explicit ?organizationId, else the active
  // account, so an entry that carries no organization (the tour hand-off, the
  // launcher "New Agent" shortcut) starts in the account Home shows. Switching
  // the account switches the whole screen with it: the org-scoped picks
  // (repositories, models, profiles) belong to the previous one, so the body
  // remounts through a stack-safe replace carrying the new ?organizationId. The
  // durable text draft survives — the pending debounced write flushes before
  // the replace, so the remount's draft load reads the newest text (the
  // replace's push lands before the old screen's unmount flush would run). A
  // clone entry is locked to its source session's org: a read-only row (an
  // explicit scope never inherits the active account). The entry's own params
  // (share prefill, clone/fork ids, run-on preselect) stay in the URL so the
  // remount keeps the same entry.
  const stackSafeRouter = useStackSafeReplace();
  const handleOrganizationSwitch = useCallback(
    (nextOrganizationId: string | null) => {
      // See ModelSelector: the sheet never re-anchors after the keyboard
      // hides, so the keyboard must be down before this push.
      Keyboard.dismiss();
      void (async () => {
        if (userId && !isCloneEntry) {
          await flushDraft(userId, NEW_SESSION_DRAFT_KEY);
        }
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(searchParams)) {
          // The typed `useLocalSearchParams` shape above makes every entry a
          // string; empty params are dropped so the route keeps no bare key.
          if (key !== 'organizationId' && value !== '') {
            params.set(key, value);
          }
        }
        if (nextOrganizationId) {
          params.set('organizationId', nextOrganizationId);
        }
        const query = params.size > 0 ? `?${params.toString()}` : '';
        stackSafeRouter.replace(`/(app)/agent-chat/new${query}` as Href);
      })();
    },
    [stackSafeRouter, searchParams, userId, isCloneEntry]
  );
  const organizationSection = (
    <View className="mt-5">
      <Text className="mb-2 text-sm font-medium text-muted-foreground">
        {t('common.organization')}
      </Text>
      {isCloneEntry ? (
        <ContextControl scope={{ organizationId: organizationId ?? null, isResolved: true }} />
      ) : (
        <ContextControl
          value={organizationId ?? null}
          onSelectionChange={handleOrganizationSwitch}
        />
      )}
    </View>
  );

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
  // re-applies the same text idempotently. A to-do's Start carries its prompt
  // the same way, so it also beats a stored draft.
  const { prompt: routePrefillPrompt, todoId, todoTitle } = useNewSessionPrefill();
  const [sharePrefillText] = useState<string | null>(() =>
    shareId ? (peekSharePayload(shareId)?.text ?? null) : (routePrefillPrompt ?? null)
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
        // The unbound computer target shares the remote model surface: the
        // catalog is empty (no connection id yet) and the view falls back to
        // the gateway-shaped options until a computer binds.
        isRemoteTarget: runOnInstance !== null || computerTargetSelected,
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
      computerTargetSelected,
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
  const {
    storedConnectionId,
    hasLoaded: hasLoadedRunOn,
    saveRunOn,
  } = usePersistedRunOnDestination();
  const attachments = useAgentAttachmentUpload({ organizationId });

  // Custom modes and the pinned model come from the effective default profile.
  // The lock applies only to the Cloud Agent target; a remote target keeps the
  // unlocked model view and never sends a gateway pin.
  const {
    customOptions,
    profileAgents,
    settled: profileSettled,
  } = useEffectiveProfileCustomModes(organizationId);
  // A computer also offers the agents its CLI loads for the selected launch
  // folder, including project agents from `.kilo/agents`.
  const { agents: cliAgents, settled: cliAgentsSettled } = useCliAgents(
    runOnInstance ? { connectionId: runOnInstance.connectionId, directory: folderPath } : null
  );
  const remoteCustomOptions = dedupeCustomModeOptions(
    mergeProfileAndRuntimeModeOptions(profileAgents, cliAgents)
  );
  // The slug the user picked from a CLI's own list on this screen.
  const cliPickedModeRef = useRef<AgentMode | null>(null);
  const handleModeChange = useCallback(
    (next: AgentMode) => {
      cliPickedModeRef.current =
        !isBuiltinAgentMode(next) &&
        !profileAgents.some(agent => agent.slug === next) &&
        cliAgents.some(agent => agent.slug === next)
          ? next
          : null;
      setMode(next);
    },
    [profileAgents, cliAgents, setMode]
  );
  // Once the target's agent lists are known, a custom mode the target does not
  // offer falls back to the default instead of being sent as the session
  // agent. On a computer this covers any custom mode, including one inherited
  // from a prefill. On Cloud only a mode picked from a CLI list is checked, so
  // an inherited custom slug keeps its earlier Cloud behavior.
  useEffect(() => {
    if (isBuiltinAgentMode(mode) || !profileSettled || !cliAgentsSettled) {
      return;
    }
    const available = runOnInstance === null ? customOptions : remoteCustomOptions;
    if (available.some(option => option.value === mode)) {
      return;
    }
    if (runOnInstance === null && cliPickedModeRef.current !== mode) {
      return;
    }
    cliPickedModeRef.current = null;
    setMode('code');
  }, [
    mode,
    profileSettled,
    cliAgentsSettled,
    runOnInstance,
    customOptions,
    remoteCustomOptions,
    setMode,
  ]);
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

  // The branch pick belongs to THIS screen, not to the repository section: the
  // section unmounts when the run target becomes a remote instance, and
  // clearing there would silently drop the user's pick while the repository
  // selection (owned by this screen) survives the toggle. Clear on the
  // screen's mount and unmount instead, so a branch never outlives the draft.
  useEffect(() => {
    resetSelectedBranchOverrides();
    return resetSelectedBranchOverrides;
  }, []);

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
    overrideNeedsAttention: profileOverrideNeedsAttention,
    refetch: refetchProfile,
  } = useEffectiveAgentProfile(organizationId, overrideProfileId);

  // The picker opens as the app's standard native formSheet. The bridge carries
  // the current pick; the sheet reports the new one back through `onSelect`.
  const handleOpenProfilePicker = useCallback(() => {
    profilePickerSlot.set(UNFENCED_ROUTE_KEY, {
      organizationId,
      selectedOverrideProfileId: overrideProfileId,
      // The server resolves a repo's bound profile at session creation; the
      // picker base layer stays empty here.
      repoBindingProfileId: null,
      onSelect: id => {
        setOverrideProfileId(id);
      },
    });
    router.push('/(app)/agent-chat/profile-picker' as Href);
  }, [organizationId, overrideProfileId, router]);

  const handleOpenRepoDefaults = useCallback(() => {
    router.push(getRepoBindingsPath(organizationId));
  }, [organizationId, router]);

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

  useEffect(() => {
    if (runOnRestoredRef.current || runOnUserPickedRef.current) {
      return;
    }
    // The tour's computer path names a connection id: wait for the live
    // instance list, then bind the real row (a disconnected id falls back to
    // Cloud Agent, exactly like the stored-preference path). The stored
    // preference is never consulted — the tour must not touch it.
    if (preselectConnectionId !== null) {
      if (instancesData === undefined) {
        return;
      }
      runOnRestoredRef.current = true;
      setRunOnInstance(resolvePersistedRunOn(preselectConnectionId, instanceList));
      return;
    }
    // The tour's computer path: bind the first connected computer (either
    // instance kind is a computer) once the list arrives; zero connected
    // leaves the target selected but unbound — Start stays disabled with the
    // setup hint and the Cloud Agent is never substituted. The stored
    // preference is never consulted or written.
    if (preselectComputer) {
      if (instancesData === undefined) {
        return;
      }
      runOnRestoredRef.current = true;
      setRunOnInstance(instanceList[0] ?? null);
      return;
    }
    // The tour's cloud path asks for the Cloud Agent target explicitly: start
    // with no remote target so the form opens on Cloud Agent, and never restore
    // the stored preference (which the tour must not touch). `runOnUserPickedRef`
    // still lets a deliberate in-form choice persist normally.
    if (!shouldRestorePersistedRunOn(preselectRunOn ?? undefined)) {
      runOnRestoredRef.current = true;
      return;
    }
    if (!hasLoadedRunOn || instancesData === undefined) {
      return;
    }
    runOnRestoredRef.current = true;
    setRunOnInstance(resolvePersistedRunOn(storedConnectionId, instanceList));
  }, [
    hasLoadedRunOn,
    instanceList,
    instancesData,
    storedConnectionId,
    preselectComputer,
    preselectConnectionId,
    preselectRunOn,
  ]);

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

  // The form owns the cloud-create failure feedback (a persistent inline
  // error), so the creator hook does not also toast the same rejection.
  const handleCloudCreateError = useCallback((failure: CloudCreateFailure) => {
    setCloudCreateError(failure);
  }, []);

  // Remote spawn success lives inside the spawn dispatch (it replaces the
  // screen). The route arms the attempt marker only after the dispatch
  // admits the spawn — voice settlement and remote admission already
  // passed — and clears the consumed draft when the screen unmounts. A
  // failed spawn keeps the screen mounted (draft preserved for retry); a
  // blocked admission or cancelled voice submit never arms the marker, so
  // the unmount flush preserves the draft.
  const { markRemoteSpawnAttempted, markRemoteSpawnFailed } = useRemoteSpawnDraftCleanup({
    userId: isCloneEntry ? undefined : userId,
  });

  // A committed remote spawn arms the discard-confirm bypass alongside the
  // draft-clearing marker. The bypass is reset when the spawn settles without
  // navigating (a failed spawn), so an abandon after a failure still confirms,
  // and the failure also disarms the draft-clearing marker so the draft
  // survives leaving to Home. The ready callback re-arms the marker for the
  // same attempt: a success that lands late (after the deadline flipped the
  // form to the inline failure and the user pressed Retry) has consumed the
  // prompt, so the unmount must still clear the draft instead of flushing it
  // back into the composer for the next visit.
  const handleSpawnAdmitted = useCallback(() => {
    markRemoteSpawnAttempted();
    skipDiscardGuardRef.current = true;
  }, [markRemoteSpawnAttempted]);
  const handleSpawnFailed = useCallback(() => {
    markRemoteSpawnFailed();
    skipDiscardGuardRef.current = false;
  }, [markRemoteSpawnFailed]);

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
  const handleSpawnReady = useCallback(() => {
    markRemoteSpawnAttempted();
    armCloneNavigateBypass();
  }, [markRemoteSpawnAttempted, armCloneNavigateBypass]);

  // A to-do start can target a remote instance instead of Cloud Agent; the
  // spawned session links to the to-do the same way the cloud path links it.
  const queryClient = useQueryClient();
  const handleSpawnSucceeded = useCallback(
    (sessionId: string) => {
      if (todoId) {
        void linkStartedTodoSession({
          queryClient,
          trpc,
          todoId,
          sessionId,
          ...(todoTitle ? { title: todoTitle } : {}),
        });
      }
    },
    [queryClient, todoId, todoTitle, trpc]
  );

  // The manual draft as the create body carries it: one plaintext value per key
  // (the editor already refuses a key that cleans onto an existing one) and the
  // non-blank setup commands in list order.
  const manualEnvVars = useMemo(
    () => Object.fromEntries(manualVars.map(variable => [variable.key, variable.value])),
    [manualVars]
  );
  const setupCommands = useMemo(
    () => manualCommands.filter(command => command.trim().length > 0),
    [manualCommands]
  );

  const { createSessionFromDraft, promptRef } = useNewSessionCreator({
    attachments,
    mode,
    model: displayModel,
    organizationId,
    onCreated: handleCreated,
    onCreateError: handleCloudCreateError,
    selectedRepository,
    setIsCreating,
    variant: displayVariant,
    autoCommit,
    profileId,
    manualEnvVars,
    setupCommands,
    todoId,
    todoTitle,
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
  const [promptSeed, setPromptSeed] = useState<NewSessionPromptSeed>('pending');
  // A prompt the user edited before the identity (and its draft load) resolved,
  // including one they cleared back to empty. The input is uncontrolled, so
  // this edit is already its visible text; the seed decision below and the
  // identity-arrival persist both honor it over any stored draft.
  const promptEditedRef = useRef(false);
  useEffect(() => {
    const decision = resolveNewSessionPromptSeedDecision({
      draftSettled: draftState.settled,
      seed: promptSeed,
      prompt: promptRef.current,
      initialPrompt,
      sharePrefillText,
      userEdited: promptEditedRef.current,
    });
    if (decision.type === 'keep') {
      return;
    }
    if (decision.type === 'reset') {
      promptRef.current = '';
      setHasPrompt(false);
      setPromptSeed('pending');
      return;
    }
    if (decision.type === 'settle') {
      setPromptSeed('settled');
      return;
    }
    // `hasPrompt` is exactly what `resolveNewSessionPromptForCreate` re-derives
    // on submit, so seeding both from one value keeps the Start gate and the
    // submitted text in agreement.
    promptRef.current = decision.prompt;
    setHasPrompt(decision.hasPrompt);
    setPromptSeed(decision.seed);
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
    // non-retryable) disarms the draft-clearing marker (the draft survives
    // the failure and the leave to Home) and re-arms the discard confirm, so
    // an abandon after a failed spawn still asks. A successful spawn replaces
    // the screen before this can run, so the bypass stays armed and the guard
    // consumes it.
    onSpawnFailed: handleSpawnFailed,
    cloneFromKiloSessionId: isCloneEntry ? cloneFromKiloSessionId : null,
    cloneUpToMessageId: cloneUpToMessageId || null,
    forkPrefillText: forkPrefillText || null,
    onCloneImportFailure: handleCloneImportFailure,
    onSpawnReady: handleSpawnReady,
    onSpawnSucceeded: handleSpawnSucceeded,
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

  // The tour's computer target with no connected computer yet: bind the first
  // one the moment a CLI connects (poll tick, Refresh, or focus refetch). The
  // one-shot restore above cannot do this — it seals after the first resolved
  // list, which may have been empty. A deliberate in-form pick wins and stops
  // the auto-bind (`runOnUserPickedRef`); binding here is transient and never
  // touches the stored preference. A retryable spawn failure that reset the
  // selection shows the disconnected note: the note asks the person to pick
  // again, so the auto-bind stays off until a deliberate choice clears it.
  useEffect(() => {
    if (!computerTargetSelected || runOnUserPickedRef.current) {
      return;
    }
    if (remoteSpawn.showInstanceDisconnectedNote) {
      return;
    }
    const first = instanceList[0];
    if (runOnInstance !== null || first === undefined) {
      return;
    }
    setRunOnInstance(first);
  }, [
    computerTargetSelected,
    instanceList,
    runOnInstance,
    remoteSpawn.showInstanceDisconnectedNote,
  ]);

  const handleRunOnChange = useCallback(
    (next: InstancePickerInstance | null) => {
      runOnUserPickedRef.current = true;
      saveRunOn(next?.connectionId ?? null);
      setRemoteOverride(null);
      setCloneImportFailureKey(null);
      // An explicit Cloud Agent pick is the one thing that leaves the tour's
      // computer target: from here the form behaves like the ordinary entry.
      setComputerTargetSelected(false);
      // The inline cloud-create failure belongs to the previous target: it
      // would render stale above Start after switching to a computer. A fresh
      // cloud attempt clears it again at press time.
      setCloudCreateError(null);
      handleRunOnInstanceChange(next);
    },
    [handleRunOnInstanceChange, saveRunOn]
  );
  function handlePromptChange(text: string) {
    promptEditedRef.current = true;
    promptRef.current = text;
    const nextHasPrompt = text.trim().length > 0;
    setHasPrompt(current => (current === nextHasPrompt ? current : nextHasPrompt));
    if (userId && !isCloneEntry) {
      saveDraft(userId, NEW_SESSION_DRAFT_KEY, text);
    }
  }

  // The composer mounts before `user.getMe` resolves, so a prompt typed in that
  // window has no account to write under and `handlePromptChange` skips the
  // save. Persist the current prompt once the identity arrives (and if it
  // changes), so text typed before the query settled survives a background or
  // kill rather than waiting for the next keystroke. An explicit edit is
  // persisted even when it left the prompt empty, so a pre-identity clear
  // replaces the stored draft instead of letting it resurface later.
  useEffect(() => {
    if (isCloneEntry || !userId) {
      return;
    }
    const text = promptRef.current;
    if (text.trim().length > 0 || promptEditedRef.current) {
      saveDraft(userId, NEW_SESSION_DRAFT_KEY, text);
    }
  }, [userId, isCloneEntry, promptRef]);

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

  // "Save as to-do" keeps the leave the confirm intercepted until a list is
  // picked; saving then discards the draft and replays that leave.
  const [saveAsTodoLeave, setSaveAsTodoLeave] = useState<(() => void) | null>(null);
  const handleSaveAsTodo = useCallback((leave: () => void) => {
    setSaveAsTodoLeave(() => leave);
  }, []);

  const { discardConfirm } = useNewSessionDiscardGuard({
    dirty: (isCloneEntry ? false : hasPrompt) || attachments.hasUnclaimedAttachments,
    hasUnclaimedAttachments: attachments.hasUnclaimedAttachments,
    onDiscard: handleDiscardDraft,
    onSaveAsTodo: !isCloneEntry && hasPrompt ? handleSaveAsTodo : undefined,
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
      await pickAgentAttachments(
        showActionSheetWithOptions,
        {
          userId,
          surface: 'agent-new',
          sessionId: null,
          // Carried so a launch this screen loses to an Activity recreation
          // reopens the same organization scope.
          organizationId: organizationId ?? null,
        },
        themedSheet
      )
    );
  }, [addCandidates, showActionSheetWithOptions, userId, themedSheet, organizationId]);

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

  const isRemoteTargetSelected = runOnInstance !== null || computerTargetSelected;
  // Clone CLI-capability gate: a full clone is optimistic (only an explicit
  // `sessionClone: false` refuses it); a fork cut needs
  // `sessionCloneAtMessage: true`. A refused CLI shows its inline reason
  // immediately; a delivered clone/import failure overrides it after a Start
  // attempt. Both clear when Run-on changes (see handleRunOnChange).
  const cloneCapabilityRefusal =
    runOnInstance === null
      ? null
      : resolveCloneCapabilityRefusal(
          { cloneFromKiloSessionId, cloneUpToMessageId },
          runOnInstance
        );
  const instanceHasSessionClone = runOnInstance !== null && cloneCapabilityRefusal === null;
  let runOnInlineNote: string | null = null;
  if (isCloneEntry && cloneCapabilityRefusal !== null) {
    runOnInlineNote = t(cloneCapabilityRefusal);
  } else if (cloneImportFailureKey !== null) {
    runOnInlineNote = t(cloneImportFailureKey);
  }
  // A cut the CLI could not find yet is shown inline but keeps Start enabled:
  // the source syncs in a moment, so a retry can succeed.
  const blockingCloneImportFailureKey =
    cloneImportFailureKey === FORK_CUT_NOT_SYNCED_KEY ? null : cloneImportFailureKey;

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
        cloneImportFailureKey: blockingCloneImportFailureKey,
        isModelUnavailable: modelView.isSelectionUnavailable,
      });
    }
    if (isRemoteTargetSelected) {
      // The computer target with no connected computer yet cannot start: the
      // spawn has no live instance to fire on. The visible blocked reason
      // below names the setup hint.
      if (runOnInstance === null) {
        return true;
      }
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

  // The repository section's own settle state, separated from the repository
  // count exactly as the extension separates provider connect from repo count.
  const hasRepositories = repositories.length > 0;
  const hasConnectableProvider = groups.some(group => group.status === 'connect');
  const isLoadingRepositories = groups.some(group => group.status === 'loading');

  const startBlockedReasonKey = resolveNewSessionStartBlockedReason(
    isCloneEntry
      ? {
          entry: 'continue',
          hasRepositories,
          hasConnectableProvider,
          isLoadingRepositories,
          isRemoteTargetSelected,
          selectedRepo,
          gate: {
            isCreating,
            isSubmitting,
            isSpawningRemote: remoteSpawn.isSpawningRemote,
            model: isRemoteTargetSelected ? modelView.selectedValue : displayModel,
            isRemoteTargetSelected,
            instanceCatalogLoading: instanceCatalog.isLoading,
            instanceHasSessionClone,
            cloneImportFailureKey: blockingCloneImportFailureKey,
            isModelUnavailable: modelView.isSelectionUnavailable,
          },
        }
      : {
          entry: 'new-session',
          hasRepositories,
          hasConnectableProvider,
          isLoadingRepositories,
          isRemoteTargetSelected,
          selectedRepo,
          gate: {
            attachmentsHasFailed: attachments.hasFailedAttachments,
            attachmentsIsUploading: attachments.isUploading,
            hasPrompt,
            isCreating,
            isRemoteTargetSelected,
            isSubmitting,
            model: displayModel,
            isProfileLoading,
          },
        }
  );

  let startBlockedReason: string | null = null;
  if (runOnInstance === null && computerTargetSelected) {
    startBlockedReason = stripInlineCodeMarkers(
      t('agentChat.instancePicker.noCliInstancesDescription')
    );
  } else if (startBlockedReasonKey === 'connect-provider') {
    startBlockedReason = t('agentChat.newSession.connectProviderToStart');
  } else if (startBlockedReasonKey === 'refresh-repositories') {
    startBlockedReason = t('agentChat.newSession.refreshRepositories');
  } else if (startBlockedReasonKey === 'select-repository') {
    startBlockedReason = t('agentChat.newSession.selectRepositoryToStart');
  }

  const handleStartSession = useCallback(() => {
    if (isCloneEntry) {
      if (runOnInstance !== null) {
        // Live CLI import: the dispatch carries the clone source id (and the
        // cut) unless the capability gate refuses the instance. A fresh
        // attempt clears a retryable "not saved yet" note.
        setCloneImportFailureKey(current => (current === FORK_CUT_NOT_SYNCED_KEY ? null : current));
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
            {
              repository: selectedRepository,
              model: displayModel,
              variant: displayVariant,
              ...(cloneUpToMessageId ? { cloneUpToMessageId } : {}),
              ...(forkPrefillText ? { forkPrefillText } : {}),
            },
            mode
          );
        } catch (error) {
          let message = i18n.t('agentChat.session.cloneFailedRetry');
          if (error instanceof Error && error.message === CLONE_CUT_NOT_FOUND_CODE) {
            // The cut message is not in the saved source yet: say so, Start stays enabled.
            message = i18n.t(FORK_CUT_NOT_SYNCED_KEY);
          } else if (!isCloudPrepareRetryableError(error)) {
            message = cloudPrepareFailureMessage(error);
          }
          toast.error(message);
        } finally {
          setIsCreating(false);
        }
      })();
      return;
    }
    if (isRemoteTargetSelected) {
      // The computer target with no connected computer yet cannot spawn: the
      // gate above keeps Start disabled, so this is a defensive guard, never
      // a cloud-create fall-through.
      if (runOnInstance === null) {
        return;
      }
      void submitWithVoiceSettled(async () => {
        remoteSpawn.onStart();
        await Promise.resolve();
      });
      return;
    }
    // A fresh attempt replaces the previous failure with either the new
    // session or the new inline error.
    setCloudCreateError(null);
    void submitWithVoiceSettled(createSessionFromDraft);
  }, [
    isCloneEntry,
    isRemoteTargetSelected,
    runOnInstance,
    cloneFromKiloSessionId,
    cloneUpToMessageId,
    forkPrefillText,
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
              title: sessionDisplayTitle(cloneSourceTitle) ?? t('agentChat.session.title'),
            })}
          </Text>
          {/* A Cloud Agent source has no per-message file edits, so a cut fork
              carries none on any destination. A remote CLI source has its
              files rebuilt at the cut and needs no note. */}
          {forkSourceIsCloudAgent ? (
            <Text className="pt-1 text-sm text-muted-foreground">
              {runOnInstance === null
                ? t('agentChat.newSession.forkFilesFromBaseBranch')
                : t('agentChat.newSession.forkFilesUnchangedOnComputer')}
            </Text>
          ) : null}
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
        customOptions={isRemoteTargetSelected ? remoteCustomOptions : customOptions}
        modelLocked={isRemoteTargetSelected ? false : Boolean(pinned.model)}
        modelLockLabel={isRemoteTargetSelected ? undefined : pinned.agentName}
        initialPrompt={initialPrompt}
        onChangeText={handlePromptChange}
        onModeChange={handleModeChange}
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
        pendingComputer={computerTargetSelected && runOnInstance === null}
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
        organizationId={organizationId}
        profile={profile}
        isProfileLoading={isProfileLoading}
        isProfileError={isProfileError}
        profileOverrideNeedsAttention={profileOverrideNeedsAttention}
        onRetryProfile={() => void refetchProfile()}
        onOpenProfilePicker={handleOpenProfilePicker}
        selectedProfileId={overrideProfileId}
        onSelectProfile={setOverrideProfileId}
        manualVars={manualVars}
        manualCommands={manualCommands}
        onManualVarsChange={setManualVars}
        onManualCommandsChange={setManualCommands}
        onOpenRepoDefaults={handleOpenRepoDefaults}
        organizationSection={organizationSection}
        autoCommit={autoCommit}
        onAutoCommitChange={setAutoCommit}
        isStartDisabled={isStartDisabled}
        isSpawningRemote={remoteSpawn.isSpawningRemote}
        startBlockedReason={startBlockedReason}
        onStartSession={handleStartSession}
        cloudCreateError={cloudCreateError}
        onRetryCloudCreate={handleStartSession}
        remoteSpawnFailure={remoteSpawn.remoteSpawnFailure}
        onRetryRemoteSpawn={handleStartSession}
      />
      {/* The discard confirm: a Modal overlay, so the composer behind it keeps
          its layout while the destructive choice keeps its red fill. */}
      {discardConfirm}
      <SaveDraftAsTodoSheet
        visible={saveAsTodoLeave !== null}
        organizationId={organizationId ?? null}
        getDraft={() => promptRef.current}
        onSaved={() => {
          saveAsTodoLeave?.();
          setSaveAsTodoLeave(null);
        }}
        onClose={() => {
          setSaveAsTodoLeave(null);
        }}
      />
    </View>
  );
}
