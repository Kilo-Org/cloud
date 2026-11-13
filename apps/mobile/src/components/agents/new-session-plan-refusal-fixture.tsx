import { useRef } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { NewSessionConfigureForm } from '@/components/agents/new-session-configure-form';
import { type ModelOption } from '@/lib/hooks/use-available-models';
import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { ScreenHeader } from '@/components/screen-header';
import { i18n } from '@/i18n';

// Development-only visual fixture, opened through the development fixture link.
// Renders the real new-session body in the state a lapsed organization's plan
// produces before any press: `organizations.list` carries the server gate's
// own verdict, so the form shows the plan explanation under the composer and
// keeps Start in its disabled style. Nothing can spawn from here, which is why
// the fixture is safe on the account that runs it.
const INSTANCE: InstancePickerInstance = {
  connectionId: 'fixture-remote-instance',
  name: 'fixture-laptop',
  projectName: 'fixture-project',
  version: 'fixture',
  kind: 'cli',
  startedAt: null,
  gitBranch: null,
};

const MODEL_OPTIONS: ModelOption[] = [
  { id: 'fixture/model', name: 'Fixture Model', variants: [], isPreferred: false },
];

const noop = (): void => undefined;

export function NewSessionPlanRefusalFixture() {
  const { t } = useTranslation();
  const voiceInputSettlerRef = useRef<(() => Promise<boolean>) | null>(null);

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('common.newSession')} />
      <NewSessionConfigureForm
        attachments={[]}
        attachmentMax={0}
        isCreating={false}
        isModelsError={false}
        isLoadingModels={false}
        mode="code"
        model="fixture/model"
        variant=""
        modelOptions={MODEL_OPTIONS}
        initialPrompt="Ship the CSV export"
        onChangeText={noop}
        onModeChange={noop}
        onModelSelect={noop}
        onAddAttachment={noop}
        onRemoveAttachment={noop}
        onRetryAttachment={noop}
        onMoveAttachment={noop}
        onReorderAttachments={noop}
        onRefetchModels={noop}
        onPrefillAttachments={() => Promise.resolve()}
        shareId={undefined}
        voiceInputSettlerRef={voiceInputSettlerRef}
        showRunOnSelector
        runOnInstance={INSTANCE}
        instanceList={[INSTANCE]}
        isLoadingInstances={false}
        isFetchingInstances={false}
        onRefreshInstances={noop}
        onChangeRunOnInstance={noop}
        showInstanceDisconnectedNote={false}
        folderPath=""
        onChangeFolderPath={noop}
        isCloneEntry={false}
        autoFocusPrompt={false}
        groups={[]}
        isRetrying={false}
        repositoryRegionSettled
        onChangeRepo={noop}
        onConnectProvider={noop}
        onRefreshRepos={noop}
        repositories={[]}
        recents={[]}
        selectedRepo=""
        organizationId={undefined}
        profile={null}
        isProfileLoading={false}
        isProfileError={false}
        profileOverrideNeedsAttention={false}
        onRetryProfile={noop}
        onOpenProfilePicker={noop}
        selectedProfileId={null}
        onSelectProfile={noop}
        manualVars={[]}
        manualCommands={[]}
        onManualVarsChange={noop}
        onManualCommandsChange={noop}
        autoCommit={false}
        onAutoCommitChange={noop}
        isSpawningRemote={false}
        isStartDisabled
        onStartSession={noop}
        planRefusal={i18n.t('common.organizationTrialEnded')}
      />
    </View>
  );
}
