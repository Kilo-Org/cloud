import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { type GatewayState, type InstanceStatus } from '@/lib/hooks/use-kiloclaw-queries';
import { cn } from '@/lib/utils';
type StatusValue = InstanceStatus | GatewayState | null | undefined;

const STATUS_COLORS: Record<string, string> = {
  running: 'bg-green-500',
  stopped: 'bg-gray-400',
  provisioned: 'bg-gray-400',
  starting: 'bg-yellow-500',
  restarting: 'bg-yellow-500',
  stopping: 'bg-yellow-500',
  destroying: 'bg-red-500',
  crashed: 'bg-red-500',
  shutting_down: 'bg-yellow-500',
};

const STATUS_LABELS: Record<string, string> = {
  running: 'Running',
  stopped: 'Stopped',
  provisioned: 'Provisioned',
  starting: 'Starting',
  restarting: 'Restarting',
  stopping: 'Stopping',
  destroying: 'Destroying',
  crashed: 'Crashed',
  shutting_down: 'Shutting Down',
};

export function StatusBadge({
  status,
  className,
}: Readonly<{ status: StatusValue; className?: string }>) {
  const dotColor = STATUS_COLORS[status ?? ''] ?? 'bg-gray-400';
  const label = STATUS_LABELS[status ?? ''] ?? 'Unknown';

  return (
    <View className={cn('flex-row items-center gap-1.5', className)}>
      <View className={cn('h-2 w-2 rounded-full', dotColor)} />
      <Text className="text-xs font-medium text-muted-foreground">{label}</Text>
    </View>
  );
}
