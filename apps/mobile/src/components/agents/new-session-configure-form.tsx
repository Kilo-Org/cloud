/* eslint-disable max-lines -- THE new-session body: one screen for every entry point, with a mutually-exclusive branch per target/state. */
import { useState } from 'react';
import { type LayoutChangeEvent, Pressable, ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

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
import { type VariableEdit } from '@/components/profiles/profile-variables-model';
import { ChevronDown } from '@/components/ui/icons';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Text } from '@/components/ui/text';
import { stripInlineCodeMarkers } from '@/i18n/plain-copy';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { remoteSpawnInstanceDisconnectedNote } from '@/lib/remote-submit-outcome';
import { useDetailScreenBottomPadding } from '@/lib/screen-insets';

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
  /**
   * The session's manual environment variables and setup commands. Owned by the
   * new-session body (not the panel) so the create carries them; the advanced
   * config editors only report changes.
   */
  manualVars: readonly VariableEdit[];
  manualCommands: readonly string[];
  onManualVarsChange: (next: VariableEdit[]) => void;
  onManualCommandsChange: (next: string[]) => void;
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
  manualVars,
  manualCommands,
  onManualVarsChange,
  onManualCommandsChange,
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
  // The form is edge-to-edge and the window never resizes for the IME on
  // either platform, so the screen needs two floors. The first is the
  // navigation-bar inset, which the pinned footer reserves itself
  // (`bottomClearance` below), so the footer can never render inside the bar:
  // the Start action sits in a footer below the scroll body, and without the
  // inset the footer would render in the navigation bar's region (a formSheet
  // over this screen no longer leaves that region exposed below itself: the
  // sheet is fixed at its shared options, `sheetShouldOverflowTopInset`). The
  // second is the keyboard height, because the composer auto-focuses on open
  // and with the keyboard up the scroll body is only ~1300 px tall while the
  // form is ~2000 px, so a Start inside the scroll would sit below the fold —
  // the user had to dismiss the keyboard (a scroll drag with
  // `keyboardDismissMode="on-drag"` did that for them) to reach the primary
  // action. Start therefore lives in a footer *outside* the ScrollView. The
  // keyboard-lift view below adds the reported IME height above that inset; it
  // is the app's cross-platform IME primitive (keyboardDidShow/DidHide on
  // Android, keyboardWillShow/WillHide on iOS), one implementation for both
  // platforms, and it wraps the footer alone, so the IME shrinks the scroll
  // body and lifts the action, and no scroll position can carry the Start
  // action under the bar or the keyboard.
  //
  // The composer reveal keeps the scroll CONTENT reachable; it does not keep
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
  // The pinned footer's single source of bottom clearance: it clears the system
  // navigation bar under Start. Without it the primary action can sit in the
  // bar's translucent region a formSheet leaves exposed below itself (the
  // picker's bottom strip showed its sliver). It rides the footer itself (see
  // pr-comment-cta.tsx for the same bar pattern) rather than a spacer inside
  // the ScrollView, which the pinned Start no longer needs and which left dead
  // space below the last field of a long form.
  const bottomClearance = useDetailScreenBottomPadding();
  // The ScrollView's keyboard-inset adjustment stays on for focused-field
  // scroll-into-view; it sizes against the scroll view's own frame, which
  // already ends above the footer, so the two never stack into a double lift.
  // (The picker-sheet sliver of the e1 spot check is fixed at the sheet
  // triggers: a formSheet anchors over the keyboard that is up at its first
  // layout and never re-anchors, so the keyboard must be dismissed before
  // the sheet opens.)
  // The scroll frame's own height, reported by the ScrollView below. It already
  // shrinks with the keyboard because `AppAwareKeyboardPaddingView` pads this
  // parent; the prompt yields its minimum height to it so the whole composer
  // card renders above the bottom system bar.
  const [frameHeight, setFrameHeight] = useState(0);
  // The composer card's top offset inside the scroll content, reported by the
  // wrapper below and threaded to the prompt. The prompt's own `onLayout` reads
  // `0` against that padding-free wrapper, dropping the content container's
  // `pt-4` gap and overstating the room the frame leaves for the input.
  const [composerTop, setComposerTop] = useState(0);
  const isRemote = runOnInstance !== null;
  const isStarting = isRemote ? isSpawningRemote : isCreating;
  const runOnNote =
    runOnInlineNote ??
    (showInstanceDisconnectedNote ? remoteSpawnInstanceDisconnectedNote() : null);

  function handleScrollFrameLayout(event: LayoutChangeEvent) {
    const next = Math.max(Math.round(event.nativeEvent.layout.height), 0);
    setFrameHeight(current => (current === next ? current : next));
  }

  const body = (
    <ScrollView
      ref={composerReveal.scrollRef}
      className="flex-1"
      contentContainerClassName="flex-grow px-4 pt-4"
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      keyboardDismissMode="on-drag"
      onLayout={event => {
        // The one layout feeds both consumers: the form frame height sets the
        // prompt's input floor, and the hook's viewport height drives the reveal.
        handleScrollFrameLayout(event);
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
          const nextTop = Math.max(Math.round(event.nativeEvent.layout.y), 0);
          setComposerTop(current => (current === nextTop ? current : nextTop));
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
          frameHeight={frameHeight}
          cardTop={composerTop}
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
        // both the profile pick and the manual env/command draft are the
        // session's own state, so one submitted create carries them all.
      }
      {!isRemote && !isCloneEntry ? (
        <AdvancedConfigPanel
          organizationId={organizationId}
          selectedProfileId={selectedProfileId}
          onSelectProfile={onSelectProfile}
          manualVars={manualVars}
          manualCommands={manualCommands}
          onManualVarsChange={onManualVarsChange}
          onManualCommandsChange={onManualCommandsChange}
          disabled={isStarting}
          onRepoDefaults={onOpenRepoDefaults}
        />
      ) : null}
    </ScrollView>
  );

  // Persistent failure feedback for the cloud create, in the reserved spot
  // directly above Start. A retryable rejection carries the retry control; a
  // terminal one says what the server reported instead. The form owns this
  // feedback, so the creator hook stays silent for it. It rides the pinned
  // footer with Start so the recovery control is visible with the keyboard up
  // too. Cloud-only: the route also clears the failure when the target
  // changes, and this gate keeps a stale one off a remote target no matter
  // which path selected it.
  const footer = (
    <View className="bg-background px-4 pt-3" style={{ paddingBottom: bottomClearance }}>
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
  );

  // The primary action is pinned below the scroll body, never part of it: a
  // Start inside the form scrolled below the fold on a short screen, so only
  // the top of the control stayed visible above the navigation bar. The lift
  // view wraps the footer alone, so the IME shrinks the body instead of
  // covering the action, and Start stays on screen above the navigation bar.
  // The footer's own padding already reserves the bottom inset
  // (`bottomClearance`), so `contentReservesBottomInset` keeps the
  // screen-bottom-anchored occlusion from counting that inset a second time.
  return (
    <View className="flex-1 bg-background">
      {body}
      <AppAwareKeyboardPaddingView contentReservesBottomInset>{footer}</AppAwareKeyboardPaddingView>
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
