import { ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { LaunchFolderField } from '@/components/agents/folder-selector';
import { NewSessionCloudCreateError } from '@/components/agents/new-session-cloud-create-error';
import { type NewSessionConfigureFormProps } from '@/components/agents/new-session-configure-form-props';
import { renderProfileRow } from '@/components/agents/new-session-profile-row';
import { NewSessionPrompt } from '@/components/agents/new-session-prompt';
import { NewSessionRepositorySection } from '@/components/agents/new-session-repository-section';
import { NewSessionRunTarget } from '@/components/agents/new-session-run-target';
import { NewSessionStartButton } from '@/components/agents/new-session-start-button';
import { useComposerRevealScroll } from '@/components/agents/use-composer-reveal-scroll';
import { AppAwareKeyboardPaddingView } from '@/components/kilo-chat/app-aware-keyboard-padding';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Text } from '@/components/ui/text';
import { stripInlineCodeMarkers } from '@/i18n/plain-copy';
import { remoteSpawnInstanceDisconnectedNote } from '@/lib/remote-submit-outcome';
import { useDetailScreenBottomPadding } from '@/lib/screen-insets';

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
  onRetryProfile,
  autoCommit,
  onAutoCommitChange,
  isSpawningRemote,
  isStartDisabled,
  onStartSession,
  cloudCreateError = null,
  onRetryCloudCreate,
}: Readonly<NewSessionConfigureFormProps>) {
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
  // The pinned footer's single source of bottom clearance: it clears the system
  // navigation bar under Start. Without it the primary action can sit in the
  // bar's translucent region a formSheet leaves exposed below itself (the
  // picker's bottom strip showed its sliver). It rides the footer itself (see
  // pr-comment-cta.tsx for the same bar pattern) rather than a spacer inside
  // the ScrollView, which the pinned Start no longer needs and which left dead
  // space below the last field of a long form.
  const bottomClearance = useDetailScreenBottomPadding();
  // The form is edge-to-edge and the window never resizes for the IME on
  // either platform, so the primary action needs two floors: the
  // navigation-bar inset, and the keyboard height. Start lives in a footer
  // *outside* the ScrollView: the composer auto-focuses on arrival, and with
  // the keyboard up the scroll body is only ~1300 px tall while the form is
  // ~2000 px, so a Start inside the scroll sits below the fold — the user had
  // to dismiss the keyboard to reach the primary action, and a scroll drag
  // (keyboardDismissMode="on-drag") did that for them. The keyboard-lift view
  // is the app's cross-platform IME primitive (keyboardDidShow/DidHide on
  // Android, keyboardWillShow/WillHide on iOS), so the same implementation
  // runs on both platforms, and it shrinks the scroll body as it lifts Start.
  // The ScrollView's keyboard-inset adjustment stays on for focused-field
  // scroll-into-view; it sizes against the scroll view's own frame, which
  // already ends above the footer, so the two never stack into a double lift.
  // (The picker-sheet sliver of the e1 spot check is fixed at the sheet
  // triggers: a formSheet anchors over the keyboard that is up at its first
  // layout and never re-anchors, so the keyboard must be dismissed before
  // the sheet opens.)
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

      {!isRemote && !isCloneEntry
        ? renderProfileRow({ t, profile, isProfileLoading, isProfileError, onRetryProfile })
        : null}
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
