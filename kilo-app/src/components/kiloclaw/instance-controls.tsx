import { Play, Power, RefreshCw, RotateCcw } from 'lucide-react-native';
import { ActivityIndicator, Alert, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { type InstanceStatus, type useKiloClawMutations } from '@/lib/hooks/use-kiloclaw';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type InstanceControlsProps = {
  status: InstanceStatus | null | undefined;
  mutations: ReturnType<typeof useKiloClawMutations>;
};

export function InstanceControls({ status, mutations }: Readonly<InstanceControlsProps>) {
  const colors = useThemeColors();

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
          mutations.start.mutate();
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
          mutations.stop.mutate();
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
          mutations.restartOpenClaw.mutate();
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
          mutations.restartMachine.mutate();
        },
      },
    ]);
  };

  return (
    <View className="gap-2">
      <View className="flex-row gap-2">
        <Button
          className="flex-1"
          variant="outline"
          size="sm"
          disabled={!canStart || mutations.start.isPending}
          onPress={handleStart}
        >
          {mutations.start.isPending ? (
            <ActivityIndicator size="small" color={colors.mutedForeground} />
          ) : (
            <Play size={14} color={canStart ? '#10b981' : colors.mutedForeground} />
          )}
          <Text>Start</Text>
        </Button>

        <Button
          className="flex-1"
          variant="outline"
          size="sm"
          disabled={!canStop || mutations.stop.isPending}
          onPress={handleStop}
        >
          {mutations.stop.isPending ? (
            <ActivityIndicator size="small" color={colors.mutedForeground} />
          ) : (
            <Power size={14} color={canStop ? '#ef4444' : colors.mutedForeground} />
          )}
          <Text>Stop</Text>
        </Button>
      </View>
      <View className="flex-row gap-2">
        <Button
          className="flex-1"
          variant="outline"
          size="sm"
          disabled={!canRestartOpenClaw || mutations.restartOpenClaw.isPending}
          onPress={handleRestartOpenClaw}
        >
          {mutations.restartOpenClaw.isPending ? (
            <ActivityIndicator size="small" color={colors.mutedForeground} />
          ) : (
            <RotateCcw size={14} color={canRestartOpenClaw ? '#f59e0b' : colors.mutedForeground} />
          )}
          <Text>Restart</Text>
        </Button>

        <Button
          className="flex-1"
          variant="outline"
          size="sm"
          disabled={!canRedeploy || mutations.restartMachine.isPending}
          onPress={handleRedeploy}
        >
          {mutations.restartMachine.isPending ? (
            <ActivityIndicator size="small" color={colors.mutedForeground} />
          ) : (
            <RefreshCw size={14} color={canRedeploy ? '#3b82f6' : colors.mutedForeground} />
          )}
          <Text>Redeploy</Text>
        </Button>
      </View>
    </View>
  );
}
