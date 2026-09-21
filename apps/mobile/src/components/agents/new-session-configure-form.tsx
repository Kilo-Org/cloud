import { useState } from 'react';
import { type LayoutChangeEvent, ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
import { remoteSpawnInstanceDisconnectedNote } from '@/lib/remote-submit-outcome';

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
  // The form is edge-to-edge and the window never resizes for the IME on
  // either platform, so the screen needs two floors: the navigation-bar inset
  // — the Start action sits in a footer below the scroll body, and without the
  // inset the footer would render in the navigation bar's region (a formSheet
  // leaves that region exposed below itself; the picker's bottom strip showed
  // its sliver) — and the keyboard height, because the composer auto-focuses
  // on open and without the keyboard floor the Start control stays half-hidden
  // behind the keyboard strip. The keyboard-lift view is the app's
  // cross-platform IME primitive (keyboardDidShow/DidHide on Android,
  // keyboardWillShow/WillHide on iOS), so the same implementation runs on both
  // platforms; the footer is its second child, so the IME lifts the action too.
  // The ScrollView's keyboard-inset adjustment stays on for focused-field
  // scroll-into-view; it sizes against the scroll view's own frame, which
  // already ends above the IME, so the two never stack into a double lift.
  // (The picker-sheet sliver of the e1 spot check is fixed at the sheet
  // triggers: a formSheet anchors over the keyboard that is up at its first
  // layout and never re-anchors, so the keyboard must be dismissed before
  // the sheet opens.)
  const { bottom } = useSafeAreaInsets();
  const isRemote = runOnInstance !== null;
  // The frame this form scrolls in: the height left once the navigation-bar
  // inset and the keyboard-lift padding are taken out. `NewSessionPrompt`
  // measures its input's min-height floor against this frame, so the input
  // gives lines up to the keyboard and takes them back when it leaves — the
  // window-based floor could not, because the window never resizes for the IME.
  const [promptViewportHeight, setPromptViewportHeight] = useState(0);
  const isStarting = isRemote ? isSpawningRemote : isCreating;
  const runOnNote =
    runOnInlineNote ??
    (showInstanceDisconnectedNote ? remoteSpawnInstanceDisconnectedNote() : null);

  function handleScrollViewportLayout(event: LayoutChangeEvent) {
    const nextHeight = Math.round(event.nativeEvent.layout.height);
    setPromptViewportHeight(current => (current === nextHeight ? current : nextHeight));
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
        handleScrollViewportLayout(event);
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
          promptViewportHeight={promptViewportHeight}
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
        {t('agentChat.newSession.remoteHint')}
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

  return (
    <View className="flex-1 bg-background" style={{ paddingBottom: bottom }}>
      <AppAwareKeyboardPaddingView className="flex-1">
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
