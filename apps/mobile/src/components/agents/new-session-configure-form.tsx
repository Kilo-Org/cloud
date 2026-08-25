import { type ReactNode, type RefObject } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { InstanceSelector } from '@/components/agents/instance-selector';
import { NewSessionPrompt } from '@/components/agents/new-session-prompt';
import { NewSessionRepositorySection } from '@/components/agents/new-session-repository-section';
import { type RepositorySectionView } from '@/components/agents/new-session-repository-state';
import { type AgentMode } from '@/components/agents/mode-selector';
import { type EffectiveAgentProfile } from '@/components/agents/use-effective-agent-profile';
import { type ModeOption } from '@/components/agents/mode-normalize';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Text } from '@/components/ui/text';
import {
  type AgentAttachment,
  type AgentAttachmentCandidate,
} from '@/lib/agent-attachments/use-agent-attachment-upload';
import { type ModelOption } from '@/lib/hooks/use-available-models';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type InstancePickerInstance, type ModelPickerSelection } from '@/lib/picker-bridge';
import { remoteSpawnInstanceDisconnectedNote } from '@/lib/remote-submit-outcome';

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
  onChangeRunOnInstance: (next: InstancePickerInstance | null) => void;
  showInstanceDisconnectedNote: boolean;
  // Repository (Cloud Agent only).
  view: RepositorySectionView;
  isRetrying: boolean;
  onChangeRepo: (fullName: string) => void;
  onOpenGitHubIntegration: () => void;
  onRefreshRepos: () => void;
  repositories: { fullName: string; isPrivate: boolean }[];
  selectedRepo: string;
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
  onRefetchModels,
  onPrefillAttachments,
  shareId,
  voiceInputSettlerRef,
  initialPrompt,
  showRunOnSelector,
  runOnInstance,
  instanceList,
  isLoadingInstances,
  onChangeRunOnInstance,
  showInstanceDisconnectedNote,
  view,
  isRetrying,
  onChangeRepo,
  onOpenGitHubIntegration,
  onRefreshRepos,
  repositories,
  selectedRepo,
  profile,
  isProfileLoading,
  isProfileError,
  onRetryProfile,
  autoCommit,
  onAutoCommitChange,
  isSpawningRemote,
  isStartDisabled,
  onStartSession,
}: Readonly<NewSessionConfigureFormProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const isRemote = runOnInstance !== null;
  const isStarting = isRemote ? isSpawningRemote : isCreating;
  const targetLabel = isRemote ? `${runOnInstance.name} · ${runOnInstance.projectName}` : null;
  let runTargetBlock: ReactNode = null;
  if (showRunOnSelector) {
    runTargetBlock = (
      <View className="mt-5">
        <Text className="mb-2 text-sm font-medium text-muted-foreground">
          {t('agentChat.instancePicker.runOn')}
        </Text>
        <InstanceSelector
          value={runOnInstance}
          instances={instanceList}
          isLoading={isLoadingInstances}
          onChange={onChangeRunOnInstance}
          disabled={isStarting}
        />
      </View>
    );
  } else if (targetLabel) {
    runTargetBlock = (
      <View className="mt-2">
        <Text className="text-sm text-muted-foreground">
          {t('agentChat.newSession.runOnWithTarget', { target: targetLabel })}
        </Text>
      </View>
    );
  }

  // Read-only effective-profile row. Hidden while the profile query loads so a
  // resolved name never flashes a "Default environment" placeholder first.
  function renderProfileRow(): ReactNode {
    if (isProfileLoading) {
      return null;
    }
    if (isProfileError) {
      return (
        <View className="mt-5">
          <Text className="mb-2 text-sm font-medium text-muted-foreground">
            {t('agentChat.newSession.environment')}
          </Text>
          <View className="flex-row items-center gap-2">
            <Text className="text-sm text-destructive">
              {t('agentChat.newSession.couldNotLoadEnvironment')}
            </Text>
            <Button
              variant="link"
              size="sm"
              onPress={onRetryProfile}
              accessibilityLabel={t('agentChat.newSession.retryLoadingEnvironment')}
            >
              <Text>{t('common.retry')}</Text>
            </Button>
          </View>
        </View>
      );
    }
    return (
      <View className="mt-5">
        <Text className="mb-2 text-sm font-medium text-muted-foreground">
          {t('agentChat.newSession.environment')}
        </Text>
        {profile ? (
          <View className="gap-1">
            <Text className="text-sm font-semibold text-foreground">{profile.name}</Text>
            <Text className="text-sm text-muted-foreground">
              {t('agentChat.newSession.environmentSummary', {
                commands: profile.commandCount,
                mcp: profile.mcpServerCount,
                skills: profile.skillCount,
                agents: profile.agentCount,
              })}
            </Text>
          </View>
        ) : (
          <Text className="text-sm text-foreground">
            {t('agentChat.newSession.defaultEnvironment')}
          </Text>
        )}
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="flex-grow px-4 pb-8 pt-4"
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
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
        onRefetchModels={onRefetchModels}
        onPrefillAttachments={onPrefillAttachments}
        shareId={shareId}
        voiceInputSettlerRef={voiceInputSettlerRef}
        initialPrompt={initialPrompt}
      />

      {runTargetBlock}

      <Text className="mt-2 text-xs text-muted-foreground">
        {t('agentChat.newSession.remoteHint')}
      </Text>

      {showInstanceDisconnectedNote ? (
        <Text className="mt-2 text-sm text-muted-foreground">
          {remoteSpawnInstanceDisconnectedNote()}
        </Text>
      ) : null}

      {!isRemote ? (
        <NewSessionRepositorySection
          disabled={isCreating}
          view={view}
          isRetrying={isRetrying}
          onChange={onChangeRepo}
          onOpenGitHubIntegration={onOpenGitHubIntegration}
          onRefreshRepos={onRefreshRepos}
          repositories={repositories}
          value={selectedRepo}
        />
      ) : null}

      {!isRemote ? (
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

      {!isRemote ? renderProfileRow() : null}

      <Button size="lg" className="mt-6" disabled={isStartDisabled} onPress={onStartSession}>
        {isStarting ? (
          <ActivityIndicator size="small" color={colors.primaryForeground} />
        ) : (
          <Text>{t('agentChat.newSession.startSession')}</Text>
        )}
      </Button>
    </ScrollView>
  );
}
