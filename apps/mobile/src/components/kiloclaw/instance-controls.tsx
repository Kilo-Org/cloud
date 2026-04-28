import { Play, Power, RefreshCw, RotateCcw } from 'lucide-react-native';
import { Alert, View } from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { type InstanceStatus, type useKiloClawMutations } from '@/lib/hooks/use-kiloclaw-queries';

type InstanceControlsProps = {
  status: InstanceStatus | null | undefined;
  mutations: ReturnType<typeof useKiloClawMutations>;
};

export function InstanceControls({ status, mutations }: Readonly<InstanceControlsProps>) {
  const canStart = status === 'stopped' || status === 'provisioned';
  const canStop = status === 'running';
  const canRestartOpenClaw = status === 'running';
  const canRedeploy = status === 'running' || status === 'stopped' || status === 'provisioned';

  const handleStart = () => {
    Alert.alert('Start Instance', 'Are you sure you want to start this instance?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Start',
        onPress: () => {
          mutations.start.mutate(undefined);
        },
      },
    ]);
  };

  const handleStop = () => {
    Alert.alert('Stop Instance', 'Are you sure you want to stop this instance?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Stop',
        style: 'destructive',
        onPress: () => {
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
          mutations.restartOpenClaw.mutate(undefined);
        },
      },
    ]);
  };

  const handleRedeploy = () => {
    Alert.alert('Redeploy Instance', 'Are you sure you want to redeploy this instance?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Redeploy',
        onPress: () => {
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
          label="Start"
          tone="accent"
          disabled={!canStart || mutations.start.isPending}
          onPress={handleStart}
        />
        <ActionButton
          icon={Power}
          label="Stop"
          tone="danger"
          disabled={!canStop || mutations.stop.isPending}
          onPress={handleStop}
        />
      </View>
      <View className="flex-row gap-2">
        <ActionButton
          icon={RotateCcw}
          label="Restart"
          tone="warn"
          disabled={!canRestartOpenClaw || mutations.restartOpenClaw.isPending}
          onPress={handleRestartOpenClaw}
        />
        <ActionButton
          icon={RefreshCw}
          label="Redeploy"
          tone="accent"
          disabled={!canRedeploy || mutations.restartMachine.isPending}
          onPress={handleRedeploy}
        />
      </View>
    </View>
  );
}
