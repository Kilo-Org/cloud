import { type RefObject } from 'react';
import { ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LaunchFolderField } from '@/components/agents/folder-selector';
import { NewSessionCloudCreateError } from '@/components/agents/new-session-cloud-create-error';
import { renderProfileRow } from '@/components/agents/new-session-profile-row';
import { NewSessionPrompt } from '@/components/agents/new-session-prompt';
import { NewSessionRepositorySection } from '@/components/agents/new-session-repository-section';
import { NewSessionRunTarget } from '@/components/agents/new-session-run-target';
import {
  type NewSessionRepository,
  type RepositoryGroup,
  type RepositoryPlatform,
} from '@/components/agents/new-session-repository-state';
import { NewSessionStartButton } from '@/components/agents/new-session-start-button';
import { type CloudCreateFailure } from '@/components/agents/use-new-session-creator';
import { type AgentMode } from '@/components/agents/mode-selector';
import { type EffectiveAgentProfile } from '@/components/agents/use-effective-agent-profile';
import { type ModeOption } from '@/components/agents/mode-normalize';
import { AppAwareKeyboardPaddingView } from '@/components/kilo-chat/app-aware-keyboard-padding';
import { InlineCodeText } from '@/components/ui/inline-code-text';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Text } from '@/components/ui/text';
import {
  type AgentAttachment,
  type AgentAttachmentCandidate,
  type AttachmentMoveDirection,
} from '@/lib/agent-attachments/use-agent-attachment-upload';
import { type ModelOption } from '@/lib/hooks/use-available-models';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { type InstancePickerInstance, type ModelPickerSelection } from '@/lib/picker-bridge';
import { remoteSpawnInstanceDisconnectedNote } from '@/lib/remote-submit-outcome';
import { useDetailScreenBottomPadding } from '@/lib/screen-insets';

type NewSessionConfigureFormProps = {
  // Prompt / model / attachments (Cloud Agent only).
  attachments: AgentAttachment[];
  attachmentMax: number;
  isCreating: boolean;
  isModelsError: boolean;
  isLoadingModels: boolean;
  mode: AgentMode;
  model: string;
  variant: string;
  modelOptions: (ModelOption | SessionModelOption)[];
  onChangeText: (text: string) => void;
  onModeChange: (mode: AgentMode) => void;
  onModelSelect: (modelId: string, variant: string, pickerSelection?: ModelPickerSelection) => void;
  /** Custom mode options shown under the built-ins in the mode picker. */
  customOptions?: ModeOption[];
  /** Locks the model picker to the pinned agent model (Cloud Agent only). */
  modelLocked?: boolean;
  /** Agent name shown in the locked model chip's accessibility label. */
  modelLockLabel?: string;
  onAddAttachment: () => void;
  onRemoveAttachment: (id: string) => void;
  onRetryAttachment: (id: string) => void;
  onMoveAttachment: (id: string, direction: AttachmentMoveDirection) => void;
  onReorderAttachments: (fromIndex: number, toIndex: number) => void;
  onRefetchModels: () => void;
  onPrefillAttachments: (candidates: AgentAttachmentCandidate[]) => Promise<void>;
  shareId: string | undefined;
  voiceInputSettlerRef: RefObject<(() => Promise<boolean>) | null>;
  initialPrompt?: string;
  // Run target.
  showRunOnSelector: boolean;
  runOnInstance: InstancePickerInstance | null;
  instanceList: InstancePickerInstance[];
  isLoadingInstances: boolean;
  isFetchingInstances: boolean;
  onRefreshInstances: () => void;
  onChangeRunOnInstance: (next: InstancePickerInstance | null) => void;
  showInstanceDisconnectedNote: boolean;
  // Launch folder (remote CLI only). `""` means the launch directory.
  folderPath: string;
  onChangeFolderPath: (path: string) => void;
  /** Continue-form inline reason shown under "Run on" (e.g. an incapable CLI or a failed clone/import). */
  runOnInlineNote?: string | null;
  /** True for the Continue clone entry: hides Changes and Environment. */
  isCloneEntry?: boolean;
  // Repository (Cloud Agent only).
  groups: RepositoryGroup[];
  isRetrying: boolean;
  onChangeRepo: (fullName: string) => void;
  onConnectProvider: (platform: RepositoryPlatform) => void;
  onRefreshRepos: () => void;
  repositories: NewSessionRepository[];
  /** Recently used rows, threaded to the picker's "Recently used" section. */
  recents: NewSessionRepository[];
  selectedRepo: string;
  /** The route's organization scope; `undefined` is a personal session. */
  organizationId: string | undefined;
  // Environment profile (Cloud Agent only).
  profile: EffectiveAgentProfile | null;
  isProfileLoading: boolean;
  isProfileError: boolean;
  onRetryProfile: () => void;
  // Commit choice (Cloud Agent only).
  autoCommit: boolean;
  onAutoCommitChange: (next: boolean) => void;
  // Start.
  isSpawningRemote: boolean;
  isStartDisabled: boolean;
  onStartSession: () => void;
  /** The last cloud-create rejection, or null before one. */
  cloudCreateError?: CloudCreateFailure | null;
  /** Re-runs the cloud create with the same draft (the retryable recovery). */
  onRetryCloudCreate?: () => void;
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
  // Clears the system navigation bar under the scroll content. Without it the
  // primary Start action can sit in the bar's translucent region a formSheet
  // leaves exposed below itself (the picker's bottom strip showed its sliver).
  const bottomClearance = useDetailScreenBottomPadding();
  // The form is edge-to-edge and the window never resizes for the IME on
  // either platform, so the scroll body needs two floors: the navigation-bar
  // inset, and the keyboard height — the composer auto-focuses on open, and
  // without the keyboard floor the Start control stays half-hidden behind
  // the keyboard strip. The keyboard-lift view is the app's cross-platform
  // IME primitive (keyboardDidShow/DidHide on Android, keyboardWillShow/
  // WillHide on iOS), so the same implementation runs on both platforms.
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
      className="flex-1"
      contentContainerClassName="flex-grow px-4 pt-4"
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      keyboardDismissMode="on-drag"
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

      <InlineCodeText
        className="mt-2 text-xs text-muted-foreground"
        value={t('agentChat.newSession.remoteHint')}
      />

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

      {
        // Persistent failure feedback for the cloud create, in the same
        // reserved spot above Start. A retryable rejection carries the retry
        // control; a terminal one says what the server reported instead. The
        // form owns this feedback, so the creator hook stays silent for it.
        // Cloud-only: the route also clears the failure when the target
        // changes, and this gate keeps a stale one off a remote target no
        // matter which path selected it.
      }
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

      <View style={{ height: bottomClearance }} pointerEvents="none" />
    </ScrollView>
  );

  return (
    <View className="flex-1 bg-background" style={{ paddingBottom: bottom }}>
      <AppAwareKeyboardPaddingView className="flex-1">{body}</AppAwareKeyboardPaddingView>
    </View>
  );
}
