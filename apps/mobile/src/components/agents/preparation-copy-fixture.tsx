import { ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { type PreparationAttempt } from '@kilocode/cloud-agent-sdk';

import { ScreenHeader } from '@/components/screen-header';

import { PreparationGroup } from './preparation-group';

/**
 * Development-only fixture for the preparation rows' copy, reached through the
 * dev preparation-copy fixture link. Reaching these rows on a device needs a
 * live session whose sandbox is actually preparing, so this screen renders the
 * real `PreparationGroup` from snapshots shaped exactly like the ones
 * `@kilocode/cloud-agent-sdk` emits. It sends no requests.
 */
const ATTEMPTS: PreparationAttempt[] = [
  {
    id: 'fixture-attempt-preparing',
    triggerMessageId: 'fixture-message-1',
    status: 'running',
    startedAt: 1,
    revision: 5,
    steps: [
      {
        id: 'fixture-step-workspace',
        key: 'workspace_setup',
        kind: 'phase',
        label: 'Workspace setup',
        status: 'completed',
        startedAt: 1,
        completedAt: 2,
        revision: 1,
      },
      {
        id: 'fixture-step-devcontainer',
        key: 'devcontainer_setup',
        kind: 'phase',
        label: 'Dev container setup',
        status: 'completed',
        startedAt: 2,
        completedAt: 3,
        revision: 2,
      },
      {
        id: 'fixture-step-cloning',
        key: 'cloning',
        kind: 'phase',
        label: 'Cloning repository',
        status: 'completed',
        startedAt: 3,
        completedAt: 4,
        revision: 3,
      },
      {
        id: 'fixture-step-branch',
        key: 'branch',
        kind: 'phase',
        label: 'Setting up branch',
        status: 'running',
        startedAt: 4,
        revision: 4,
        latestDetail: 'Checking out branch',
      },
    ],
  },
  {
    id: 'fixture-attempt-container-limit',
    triggerMessageId: 'fixture-message-2',
    status: 'failed',
    startedAt: 10,
    completedAt: 11,
    revision: 1,
    safeError: 'container_limit_reached',
    steps: [],
  },
  {
    id: 'fixture-attempt-restore',
    triggerMessageId: 'fixture-message-3',
    status: 'completed',
    startedAt: 20,
    completedAt: 23,
    revision: 2,
    steps: [
      {
        id: 'fixture-step-restore',
        key: 'workspace_restore',
        kind: 'phase',
        label: 'Restoring workspace',
        status: 'completed',
        startedAt: 20,
        completedAt: 21,
        revision: 1,
      },
      {
        id: 'fixture-step-restore-incomplete',
        key: 'restore_incomplete',
        kind: 'phase',
        label: 'Session restore incomplete',
        status: 'completed',
        startedAt: 21,
        completedAt: 22,
        revision: 2,
        safeError:
          'Session restore incomplete: 1 of 3 files were not restored (the patch did not apply). Missing: src/app.ts',
      },
    ],
  },
  {
    id: 'fixture-attempt-sandbox',
    triggerMessageId: 'fixture-message-4',
    status: 'failed',
    startedAt: 30,
    completedAt: 33,
    revision: 2,
    steps: [
      {
        id: 'fixture-step-sandbox-provision',
        key: 'sandbox_provision',
        kind: 'phase',
        label: 'Provisioning sandbox',
        status: 'failed',
        startedAt: 30,
        completedAt: 31,
        revision: 1,
        safeError: 'sandbox_out_of_memory',
      },
      {
        id: 'fixture-step-sandbox-boot',
        key: 'sandbox_boot',
        kind: 'phase',
        label: 'Starting sandbox',
        status: 'failed',
        startedAt: 31,
        completedAt: 32,
        revision: 2,
        safeError: 'sandbox_lost',
      },
    ],
  },
  {
    id: 'fixture-attempt-credential',
    triggerMessageId: 'fixture-message-5',
    status: 'failed',
    startedAt: 40,
    completedAt: 41,
    revision: 1,
    safeError: 'credential_upgrade_required',
    steps: [],
  },
];

export function PreparationCopyFixture() {
  const { t } = useTranslation();

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('agentChat.preparation.preparingEnvironment')} />
      <ScrollView contentContainerClassName="pb-8">
        {ATTEMPTS.map(attempt => (
          <PreparationGroup key={attempt.id} attempt={attempt} />
        ))}
      </ScrollView>
    </View>
  );
}
