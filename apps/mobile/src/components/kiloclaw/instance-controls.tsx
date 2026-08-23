import { Play, Power, RefreshCw, RotateCcw } from '@/components/ui/icons';
import { Alert, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ActionButton } from '@/components/ui/action-button';
import { captureEvent, INSTANCE_ACTION_EVENT } from '@/lib/analytics/posthog';
import { type InstanceStatus, type useKiloClawMutations } from '@/lib/hooks/use-kiloclaw-queries';

type InstanceControlsProps = {
  status: InstanceStatus | null | undefined;
  mutations: ReturnType<typeof useKiloClawMutations>;
};

// Statuses where the backend is already mid-transition — starting or
// redeploying now would race an in-flight lifecycle change. Anything NOT in
// this set (including 'stopped', 'provisioned', 'crashed', and any
// unrecognized/null status) is fair game to start. Redeploy is additionally
// allowed while 'running' (the only status this set adds beyond redeploy's
// own blocking list).
const START_BLOCKING_STATUSES = new Set([
  'running',
  'starting',
  'restarting',
  'stopping',
  'shutting_down',
  'destroying',
  'recovering',
  'restoring',
]);

export function InstanceControls({ status, mutations }: Readonly<InstanceControlsProps>) {
  const { t } = useTranslation();
  const canStart = status == null || !START_BLOCKING_STATUSES.has(status);
  const canStop = status === 'running';
  const canRestartOpenClaw = status === 'running';
  const canRedeploy = canStart || status === 'running';

  // Only one lifecycle mutation should ever be in flight at a time — while
  // any of these is pending (including destroy, initiated from DangerZone),
  // disable the rest so they can't race each other.
  const isLifecycleBusy =
    mutations.start.isPending ||
    mutations.stop.isPending ||
    mutations.restartOpenClaw.isPending ||
    mutations.restartMachine.isPending ||
    mutations.destroy.isPending;

  const handleStart = () => {
    Alert.alert(t('kiloclaw.controls.startTitle'), t('kiloclaw.controls.startMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('kiloclaw.controls.start'),
        onPress: () => {
          captureEvent(INSTANCE_ACTION_EVENT, { surface: 'claw', action: 'start' });
          mutations.start.mutate(undefined);
        },
      },
    ]);
  };

  const handleStop = () => {
    Alert.alert(t('kiloclaw.controls.stopTitle'), t('kiloclaw.controls.stopMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('kiloclaw.controls.stop'),
        style: 'destructive',
        onPress: () => {
          captureEvent(INSTANCE_ACTION_EVENT, { surface: 'claw', action: 'stop' });
          mutations.stop.mutate(undefined);
        },
      },
    ]);
  };

  const handleRestartOpenClaw = () => {
    Alert.alert(
      t('kiloclaw.controls.restartOpenClawTitle'),
      t('kiloclaw.controls.restartOpenClawMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('kiloclaw.controls.restart'),
          onPress: () => {
            captureEvent(INSTANCE_ACTION_EVENT, { surface: 'claw', action: 'restart_openclaw' });
            mutations.restartOpenClaw.mutate(undefined);
          },
        },
      ]
    );
  };

  const handleRedeploy = () => {
    Alert.alert(t('kiloclaw.redeployTitle'), t('kiloclaw.redeployMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('kiloclaw.redeploy'),
        onPress: () => {
          captureEvent(INSTANCE_ACTION_EVENT, { surface: 'claw', action: 'redeploy' });
          mutations.restartMachine.mutate(undefined);
        },
      },
    ]);
  };

  return (
    <View className="gap-2">
      <View className="flex-row gap-2">
        <ActionButton
          icon={Play}
          label={
            mutations.start.isPending
              ? t('kiloclaw.controls.starting')
              : t('kiloclaw.controls.start')
          }
          tone="accent"
          disabled={!canStart || isLifecycleBusy}
          loading={mutations.start.isPending}
          onPress={handleStart}
        />
        <ActionButton
          icon={Power}
          label={
            mutations.stop.isPending ? t('kiloclaw.controls.stopping') : t('kiloclaw.controls.stop')
          }
          tone="danger"
          disabled={!canStop || isLifecycleBusy}
          loading={mutations.stop.isPending}
          onPress={handleStop}
        />
      </View>
      <View className="flex-row gap-2">
        <ActionButton
          icon={RotateCcw}
          label={
            mutations.restartOpenClaw.isPending
              ? t('kiloclaw.controls.restarting')
              : t('kiloclaw.controls.restart')
          }
          tone="warn"
          disabled={!canRestartOpenClaw || isLifecycleBusy}
          loading={mutations.restartOpenClaw.isPending}
          onPress={handleRestartOpenClaw}
        />
        <ActionButton
          icon={RefreshCw}
          label={
            mutations.restartMachine.isPending
              ? t('kiloclaw.controls.redeploying')
              : t('kiloclaw.redeploy')
          }
          tone="accent"
          disabled={!canRedeploy || isLifecycleBusy}
          loading={mutations.restartMachine.isPending}
          onPress={handleRedeploy}
        />
      </View>
    </View>
  );
}
