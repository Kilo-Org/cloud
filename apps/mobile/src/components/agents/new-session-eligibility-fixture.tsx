import { useRef } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { CloudAgentEligibilityNotice } from '@/components/agents/cloud-agent-eligibility-notice';
import { NewSessionConfigureForm } from '@/components/agents/new-session-configure-form';
import { ScreenHeader } from '@/components/screen-header';
import { type CloudAgentEligibilityState } from '@/lib/cloud-agent-eligibility';
import { type ModelOption } from '@/lib/hooks/use-available-models';

// Development-only visual fixture, opened through the development fixture link.
// Renders the real new-session form with the Cloud Agent access notice in the
// state the backend answers for a balance under the minimum, so the design gate
// can measure the block on both revisions instead of needing an account whose
// credits it would have to spend down. The `?state=` query picks the reader's
// state, and the fixture supplies the verdict itself, which is why nothing can
// spawn from here.

const MODEL_OPTIONS: ModelOption[] = [
  {
    id: 'fixture/free-model',
    name: 'Fixture Free Model',
    variants: [],
    isPreferred: true,
    isFree: true,
  },
  {
    id: 'fixture/byok-model',
    name: 'Fixture BYOK Model',
    variants: [],
    isPreferred: false,
    hasUserByokAvailable: true,
  },
];

const noop = (): void => undefined;

/** The states the notice can show, as the fixture's `?state=` names them. */
export type NewSessionEligibilityFixtureState = 'limited' | 'unavailable';

export function NewSessionEligibilityFixture({
  state = 'limited',
}: Readonly<{ state?: NewSessionEligibilityFixtureState }>) {
  const { t } = useTranslation();
  const voiceInputSettlerRef = useRef<(() => Promise<boolean>) | null>(null);
  // The backend's own answer for a balance under the Cloud Agent minimum, and
  // the state a read that never answered draws.
  const eligibilityState: CloudAgentEligibilityState =
    state === 'unavailable'
      ? { kind: 'failed', isRetrying: false }
      : {
          kind: 'ready',
          eligibility: { balance: 0, minBalance: 1, accessLevel: 'limited', isEligible: false },
        };

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
        model="fixture/free-model"
        variant=""
        modelOptions={MODEL_OPTIONS}
        initialPrompt="Add a CSV export to the reports page"
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
        runOnInstance={null}
        instanceList={[]}
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
        eligibilityNotice={
          <CloudAgentEligibilityNotice
            state={eligibilityState}
            organizationId={undefined}
            onRetry={noop}
          />
        }
      />
    </View>
  );
}
