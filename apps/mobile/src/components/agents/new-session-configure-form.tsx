/* eslint-disable max-lines -- THE new-session body: one screen for every entry point, with a mutually-exclusive branch per target/state. */
import { Pressable, ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LaunchFolderField } from '@/components/agents/folder-selector';
import { ActiveProfileIndicator } from '@/components/agents/active-profile-indicator';
import { buildActiveProfileIndicatorState } from '@/components/agents/active-profile-indicator-model';
import { AdvancedConfigPanel } from '@/components/agents/advanced-config-panel';
import { NewSessionCloudCreateError } from '@/components/agents/new-session-cloud-create-error';
import { type NewSessionConfigureFormProps } from '@/components/agents/new-session-configure-form-props';
import { renderProfileRowBody } from '@/components/agents/new-session-profile-row';
import { type EffectiveAgentProfile } from '@/components/agents/use-effective-agent-profile';
import { NewSessionPrompt } from '@/components/agents/new-session-prompt';
import { NewSessionRepositorySection } from '@/components/agents/new-session-repository-section';
import { NewSessionRunTarget } from '@/components/agents/new-session-run-target';
import { NewSessionStartButton } from '@/components/agents/new-session-start-button';
import { useComposerRevealScroll } from '@/components/agents/use-composer-reveal-scroll';
import { AppAwareKeyboardPaddingView } from '@/components/kilo-chat/app-aware-keyboard-padding';
import { ChevronDown } from '@/components/ui/icons';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Text } from '@/components/ui/text';
import { stripInlineCodeMarkers } from '@/i18n/plain-copy';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { remoteSpawnInstanceDisconnectedNote } from '@/lib/remote-submit-outcome';

/**
 * The profile override the new-session screen adds to the shared contract: the
 * Environment row and the advanced-config selector drive one session-level pick.
 * The base fields live in `new-session-configure-form-props`, extracted so this
 * file stays within the repo's line cap.
 */
type NewSessionProfileOverrideProps = {
  /** The picked override no longer resolves to a profile. */
  profileOverrideNeedsAttention: boolean;
  /** Opens the profile picker sheet. */
  onOpenProfilePicker: () => void;
  /**
   * The session's profile override, shared by the Environment row and the
   * advanced-config selector; null keeps the effective default.
   */
  selectedProfileId: string | null;
  /** Reports a pick (or `No profile`) from the advanced-config selector. */
  onSelectProfile: (id: string | null) => void;
  /** Opens the repo default-profile bindings screen from the advanced config. */
  onOpenRepoDefaults?: () => void;
};

/**
 * THE new-session screen body — one screen for every entry point (cloud,
 * remote CLI, share-staged). The composer, the mode and the model controls
 * are shared by both targets. Only the repository section is cloud-only,
 * because a spawned CLI session inherits its repository from the CLI.
 */
export function NewSessionConfigureForm({
  attachments,
  attachmentMax,
  isCreating,
  isModelsError,
  isLoadingModels,
  mode,
  model,
  variant,
  modelOptions,
  onChangeText,
  onModeChange,
  onModelSelect,
  customOptions = [],
  modelLocked = false,
  modelLockLabel,
  onAddAttachment,
  onRemoveAttachment,
  onRetryAttachment,
  onMoveAttachment,
  onReorderAttachments,
  onRefetchModels,
  onPrefillAttachments,
  shareId,
  voiceInputSettlerRef,
  initialPrompt,
  showRunOnSelector,
  runOnInstance,
  instanceList,
  isLoadingInstances,
  isFetchingInstances,
  onRefreshInstances,
  onChangeRunOnInstance,
  showInstanceDisconnectedNote,
  folderPath,
  onChangeFolderPath,
  runOnInlineNote,
  isCloneEntry = false,
  groups,
  isRetrying,
  onChangeRepo,
  onConnectProvider,
  onRefreshRepos,
  repositories,
  recents,
  selectedRepo,
  organizationId,
  profile,
  isProfileLoading,
  isProfileError,
  profileOverrideNeedsAttention,
  onRetryProfile,
  onOpenProfilePicker,
  selectedProfileId,
  onSelectProfile,
  onOpenRepoDefaults,
  autoCommit,
  onAutoCommitChange,
  isSpawningRemote,
  isStartDisabled,
  onStartSession,
  cloudCreateError = null,
  onRetryCloudCreate,
}: Readonly<NewSessionConfigureFormProps & NewSessionProfileOverrideProps>) {
  const { t } = useTranslation();
  // The two floors below keep the scroll CONTENT reachable; they do not keep
  // the composer card's own bottom row (the mode/model pills) above the IME —
  // the card is the first child, so it is drawn under the keyboard. This
  // reveal scrolls the card's bottom edge to the viewport's bottom, changing
  // only the content offset (never a size) so no surrounding layout moves.
  // The hook feeds the live offset back with `onScroll`, so when the IME
  // closes it can give the keyboard-down view its offset back: the form is far
  // taller than the lifted viewport, and without the restore the card's top
  // edge (rounded corner, top padding, the prompt's first line) comes back
  // clipped under the header.
  const composerReveal = useComposerRevealScroll();
  // The form is edge-to-edge and the window never resizes for the IME on
  // either platform, so the screen needs two floors: the navigation-bar inset
  // — the Start action sits in a footer below the scroll body, and without the
  // inset the footer would render in the navigation bar's region (a formSheet
  // over this screen no longer leaves that region exposed below itself: the
  // sheet is fixed at its shared options, `sheetShouldOverflowTopInset`) — and
  // the keyboard height, because the composer auto-focuses on open and without
  // the keyboard floor the Start control stays half-hidden behind the keyboard
  // strip. The keyboard-lift view is the app's cross-platform IME primitive
  // (keyboardDidShow/DidHide on Android, keyboardWillShow/WillHide on iOS), so
  // the same implementation runs on both platforms; the footer is its second
  // child, so the IME lifts the action too.
  // The ScrollView's keyboard-inset adjustment stays on for focused-field
  // scroll-into-view; it sizes against the scroll view's own frame, which
  // already ends above the IME, so the two never stack into a double lift.
  // (The picker-sheet sliver of the e1 spot check is fixed at the sheet
  // triggers: a formSheet anchors over the keyboard that is up at its first
  // layout and never re-anchors, so the keyboard must be dismissed before
  // the sheet opens.)
  const { bottom } = useSafeAreaInsets();
  const isRemote = runOnInstance !== null;
  const isStarting = isRemote ? isSpawningRemote : isCreating;
  const runOnNote =
    runOnInlineNote ??
    (showInstanceDisconnectedNote ? remoteSpawnInstanceDisconnectedNote() : null);

  const body = (
    <ScrollView
      ref={composerReveal.scrollRef}
      className="flex-1"
      contentContainerClassName="flex-grow px-4 pt-4"
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      keyboardDismissMode="on-drag"
      onLayout={event => {
        composerReveal.onViewportLayout(event.nativeEvent.layout.height);
      }}
      onScroll={event => {
        composerReveal.onScroll(event.nativeEvent.contentOffset.y);
      }}
      scrollEventThrottle={16}
      onScrollBeginDrag={() => {
        composerReveal.onUserScroll();
      }}
    >
      <View
        onLayout={event => {
          composerReveal.onComposerLayout({
            y: event.nativeEvent.layout.y,
            height: event.nativeEvent.layout.height,
          });
        }}
      >
        <NewSessionPrompt
          attachments={attachments}
          attachmentMax={attachmentMax}
          isCreating={isStarting}
          isModelsError={isModelsError}
          isLoadingModels={isLoadingModels}
          mode={mode}
          model={model}
          variant={variant}
          modelOptions={modelOptions}
          onChangeText={onChangeText}
          onModeChange={onModeChange}
          onModelSelect={onModelSelect}
          customOptions={customOptions}
          modelLocked={modelLocked}
          modelLockLabel={modelLockLabel}
          onAddAttachment={onAddAttachment}
          onRemoveAttachment={onRemoveAttachment}
          onRetryAttachment={onRetryAttachment}
          onMoveAttachment={onMoveAttachment}
          onReorderAttachments={onReorderAttachments}
          onRefetchModels={onRefetchModels}
          onPrefillAttachments={onPrefillAttachments}
          shareId={shareId}
          voiceInputSettlerRef={voiceInputSettlerRef}
          initialPrompt={initialPrompt}
          onStartSession={isStartDisabled ? undefined : onStartSession}
          isCloneEntry={isCloneEntry}
        />
      </View>

      <NewSessionRunTarget
        showRunOnSelector={showRunOnSelector}
        runOnInstance={runOnInstance}
        instanceList={instanceList}
        isLoadingInstances={isLoadingInstances}
        isFetchingInstances={isFetchingInstances}
        onChangeRunOnInstance={onChangeRunOnInstance}
        onRefreshInstances={onRefreshInstances}
        disabled={isStarting}
      />

      {isRemote ? (
        <LaunchFolderField
          folderPath={folderPath}
          runOnInstance={runOnInstance}
          onChangeFolderPath={onChangeFolderPath}
          disabled={isStarting}
        />
      ) : null}

      <Text className="mt-2 text-xs text-muted-foreground">
        {stripInlineCodeMarkers(t('agentChat.newSession.remoteHint'))}
      </Text>

      {runOnNote ? <Text className="mt-2 text-sm text-muted-foreground">{runOnNote}</Text> : null}

      {!isRemote ? (
        <NewSessionRepositorySection
          disabled={isCreating}
          groups={groups}
          isRetrying={isRetrying}
          onChange={onChangeRepo}
          onConnect={onConnectProvider}
          onRefreshRepos={onRefreshRepos}
          repositories={repositories}
          recents={recents}
          value={selectedRepo}
          organizationId={organizationId}
          isCloneEntry={isCloneEntry}
        />
      ) : null}

      {!isRemote && !isCloneEntry ? (
        <View className="mt-5">
          <Text className="mb-2 text-sm font-medium text-muted-foreground">
            {t('agentChat.newSession.changes')}
          </Text>
          <SegmentedControl
            accessibilityLabel={t('agentChat.newSession.changes')}
            options={[
              { value: 'leave', label: t('agentChat.newSession.leaveChanges') },
              { value: 'commit', label: t('agentChat.newSession.commitAndPush') },
            ]}
            value={autoCommit ? 'commit' : 'leave'}
            onChange={next => {
              onAutoCommitChange(next === 'commit');
            }}
          />
        </View>
      ) : null}

      {!isRemote && !isCloneEntry ? (
        <NewSessionProfileRow
          profile={profile}
          isProfileLoading={isProfileLoading}
          isProfileError={isProfileError}
          overrideNeedsAttention={profileOverrideNeedsAttention}
          onRetryProfile={onRetryProfile}
          onOpenProfilePicker={onOpenProfilePicker}
        />
      ) : null}

      {
        // The advanced configuration disclosure sits under Environment. It is
        // collapsed by default, so the screen is unchanged until it is tapped;
        // the panel owns its manual config state, while the profile pick is
        // the session's own override so both selectors drive one submitted id.
      }
      {!isRemote && !isCloneEntry ? (
        <AdvancedConfigPanel
          organizationId={organizationId}
          selectedProfileId={selectedProfileId}
          onSelectProfile={onSelectProfile}
          disabled={isStarting}
          onRepoDefaults={onOpenRepoDefaults}
        />
      ) : null}
    </ScrollView>
  );

  return (
    // The root reserves the navigation-bar inset, so the keyboard-lift view
    // pads from its own bottom edge and must not add the inset again.
    <View className="flex-1 bg-background" style={{ paddingBottom: bottom }}>
      <AppAwareKeyboardPaddingView className="flex-1" containerReservesBottomInset>
        {body}
        {/*
          The primary action is pinned below the scroll body, never part of it.
          A Start button inside the form scrolled out of the viewport on a short
          screen: only the top of the control stayed visible above the
          navigation bar, which read as a button the bottom bar had cut off.
          As the keyboard-lift view's second child the footer is always on
          screen, clear of the navigation bar, and lifted above the IME.
        */}
        <View className="px-4 pb-4">
          {/*
            Persistent failure feedback for the cloud create, in the reserved
            spot above Start. A retryable rejection carries the retry control;
            a terminal one says what the server reported instead. It rides with
            the action it answers, so the feedback is on screen wherever the
            body is scrolled. The form owns this feedback, so the creator hook
            stays silent for it. Cloud-only: the route also clears the failure
            when the target changes, and this gate keeps a stale one off a
            remote target no matter which path selected it.
          */}
          {cloudCreateError && !isRemote ? (
            <NewSessionCloudCreateError
              failure={cloudCreateError}
              onRetry={onRetryCloudCreate}
              isRetryDisabled={isStartDisabled}
            />
          ) : null}

          <NewSessionStartButton
            isCloneEntry={isCloneEntry}
            isRemote={isRemote}
            isStartDisabled={isStartDisabled}
            isStarting={isStarting}
            onStartSession={onStartSession}
          />
        </View>
      </AppAwareKeyboardPaddingView>
    </View>
  );
}

type NewSessionProfileRowProps = {
  profile: EffectiveAgentProfile | null;
  isProfileLoading: boolean;
  isProfileError: boolean;
  /** The picked override no longer resolves to a profile. */
  overrideNeedsAttention: boolean;
  onRetryProfile: () => void;
  /** Opens the profile picker sheet. */
  onOpenProfilePicker: () => void;
};

/**
 * The new-session Environment row: a tappable summary of the effective profile
 * with the active-profile indicator beside its label. Loading and failure keep
 * the shared body's reserved lines, so the rows below never move when the query
 * settles and no default flashes before it does; the settled row is the entry
 * point that opens the profile picker.
 *
 * It lives with this screen rather than in `new-session-profile-row` because
 * the indicator and the chevron reach the app's icon barrel, which the mounted
 * suite that renders the read-only row cannot load.
 */
export function NewSessionProfileRow({
  profile,
  isProfileLoading,
  isProfileError,
  overrideNeedsAttention,
  onRetryProfile,
  onOpenProfilePicker,
}: Readonly<NewSessionProfileRowProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();

  const indicatorState = buildActiveProfileIndicatorState({
    selectedProfileName: profile?.name ?? null,
    repoBoundProfileName: null,
    hasManualEnvVars: false,
    hasManualSetupCommands: false,
    hasSelectedProfileId: profile !== null || overrideNeedsAttention,
    isProfilesLoading: isProfileLoading,
    hasProfileError: isProfileError,
  });

  return (
    <View className="mt-5">
      <View className="mb-2 flex-row items-center justify-between gap-2">
        <Text className="text-sm font-medium text-muted-foreground">
          {t('agentChat.newSession.environment')}
        </Text>
        <ActiveProfileIndicator state={indicatorState} onPress={onOpenProfilePicker} />
      </View>
      {isProfileLoading || isProfileError ? (
        renderProfileRowBody({ t, profile, isProfileLoading, isProfileError, onRetryProfile })
      ) : (
        <Pressable
          className="min-h-11 flex-row items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5 active:opacity-70"
          onPress={onOpenProfilePicker}
          accessibilityRole="button"
          accessibilityLabel={t('agentChat.newSession.pickProfile')}
        >
          <View className="min-w-0 flex-1 gap-1">
            {overrideNeedsAttention ? (
              <Text className="text-sm text-warn">
                {t('agentChat.newSession.configNeedsAttention')}
              </Text>
            ) : null}
            <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
              {profile?.name ?? t('agentChat.newSession.defaultEnvironment')}
            </Text>
            {profile ? (
              <Text className="text-sm text-muted-foreground" numberOfLines={1}>
                {t('agentChat.newSession.environmentSummary', {
                  commands: profile.commandCount,
                  mcp: profile.mcpServerCount,
                  skills: profile.skillCount,
                  agents: profile.agentCount,
                })}
              </Text>
            ) : null}
          </View>
          <ChevronDown size={18} color={colors.mutedForeground} />
        </Pressable>
      )}
    </View>
  );
}
