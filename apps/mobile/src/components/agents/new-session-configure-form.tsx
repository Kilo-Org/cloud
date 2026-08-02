import { type ReactNode, type RefObject } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';

import { InstanceSelector } from '@/components/agents/instance-selector';
import { NewSessionPrompt } from '@/components/agents/new-session-prompt';
import { NewSessionRepositorySection } from '@/components/agents/new-session-repository-section';
import { type RepositorySectionView } from '@/components/agents/new-session-repository-state';
import { type AgentMode } from '@/components/agents/mode-selector';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import {
  type AgentAttachment,
  type AgentAttachmentCandidate,
} from '@/lib/agent-attachments/use-agent-attachment-upload';
import { type ModelOption } from '@/lib/hooks/use-available-models';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { REMOTE_SPAWN_INSTANCE_DISCONNECTED_NOTE } from '@/lib/remote-submit-outcome';

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
  modelOptions: ModelOption[];
  onChangeText: (text: string) => void;
  onModeChange: (mode: AgentMode) => void;
  onModelSelect: (modelId: string, variant: string) => void;
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
  // Start.
  isSpawningRemote: boolean;
  isStartDisabled: boolean;
  onStartSession: () => void;
};

/**
 * THE new-session screen body — one screen for every entry point (cloud,
 * remote CLI, share-staged). Sections condition on the selected target;
 * remote has no prompt/repo because a spawned CLI session inherits
 * model+repo. Switching the target switches the sections in place.
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
  isSpawningRemote,
  isStartDisabled,
  onStartSession,
}: Readonly<NewSessionConfigureFormProps>) {
  const colors = useThemeColors();
  const isRemote = runOnInstance !== null;
  const isStarting = isRemote ? isSpawningRemote : isCreating;
  const targetLabel = isRemote ? `${runOnInstance.name} · ${runOnInstance.projectName}` : null;
  let runTargetBlock: ReactNode = null;
  if (showRunOnSelector) {
    runTargetBlock = (
      <View className="mt-5">
        <Text className="mb-2 text-sm font-medium text-muted-foreground">Run on</Text>
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
        <Text className="text-sm text-muted-foreground">Run on: {targetLabel}</Text>
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
      {!isRemote ? (
        <NewSessionPrompt
          attachments={attachments}
          attachmentMax={attachmentMax}
          isCreating={isCreating}
          isModelsError={isModelsError}
          isLoadingModels={isLoadingModels}
          mode={mode}
          model={model}
          variant={variant}
          modelOptions={modelOptions}
          onChangeText={onChangeText}
          onModeChange={onModeChange}
          onModelSelect={onModelSelect}
          onAddAttachment={onAddAttachment}
          onRemoveAttachment={onRemoveAttachment}
          onRetryAttachment={onRetryAttachment}
          onRefetchModels={onRefetchModels}
          onPrefillAttachments={onPrefillAttachments}
          shareId={shareId}
          voiceInputSettlerRef={voiceInputSettlerRef}
          initialPrompt={initialPrompt}
        />
      ) : null}

      {runTargetBlock}

      {showInstanceDisconnectedNote ? (
        <Text className="mt-2 text-sm text-muted-foreground">
          {REMOTE_SPAWN_INSTANCE_DISCONNECTED_NOTE}
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

      <Button size="lg" className="mt-6" disabled={isStartDisabled} onPress={onStartSession}>
        {isStarting ? (
          <ActivityIndicator size="small" color={colors.primaryForeground} />
        ) : (
          <Text>Start session</Text>
        )}
      </Button>
    </ScrollView>
  );
}
