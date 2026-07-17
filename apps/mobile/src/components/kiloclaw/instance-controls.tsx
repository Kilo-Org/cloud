import { Play, Power, RefreshCw, RotateCcw } from 'lucide-react-native';
import { Alert, View } from 'react-native';

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
    Alert.alert('Start instance', 'Are you sure you want to start this instance?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Start',
        onPress: () => {
          captureEvent(INSTANCE_ACTION_EVENT, { surface: 'claw', action: 'start' });
          mutations.start.mutate(undefined);
        },
      },
    ]);
  };

  const handleStop = () => {
    Alert.alert('Stop instance', 'Are you sure you want to stop this instance?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Stop',
        style: 'destructive',
        onPress: () => {
          captureEvent(INSTANCE_ACTION_EVENT, { surface: 'claw', action: 'stop' });
          mutations.stop.mutate(undefined);
        },
      },
    ]);
  };

  const handleRestartOpenClaw = () => {
    Alert.alert('Restart OpenClaw', 'Are you sure you want to restart the OpenClaw process?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Restart',
        onPress: () => {
          captureEvent(INSTANCE_ACTION_EVENT, { surface: 'claw', action: 'restart_openclaw' });
          mutations.restartOpenClaw.mutate(undefined);
        },
      },
    ]);
  };

  const handleRedeploy = () => {
    Alert.alert('Redeploy instance', 'Are you sure you want to redeploy this instance?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Redeploy',
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
          label={mutations.start.isPending ? 'Starting…' : 'Start'}
          tone="accent"
          disabled={!canStart || isLifecycleBusy}
          loading={mutations.start.isPending}
          onPress={handleStart}
        />
        <ActionButton
          icon={Power}
          label={mutations.stop.isPending ? 'Stopping…' : 'Stop'}
          tone="danger"
          disabled={!canStop || isLifecycleBusy}
          loading={mutations.stop.isPending}
          onPress={handleStop}
        />
      </View>
      <View className="flex-row gap-2">
        <ActionButton
          icon={RotateCcw}
          label={mutations.restartOpenClaw.isPending ? 'Restarting…' : 'Restart'}
          tone="warn"
          disabled={!canRestartOpenClaw || isLifecycleBusy}
          loading={mutations.restartOpenClaw.isPending}
          onPress={handleRestartOpenClaw}
        />
        <ActionButton
          icon={RefreshCw}
          label={mutations.restartMachine.isPending ? 'Redeploying…' : 'Redeploy'}
          tone="accent"
          disabled={!canRedeploy || isLifecycleBusy}
          loading={mutations.restartMachine.isPending}
          onPress={handleRedeploy}
        />
      </View>
    </View>
  );
}
