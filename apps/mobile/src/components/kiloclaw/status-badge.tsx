import { View } from 'react-native';

import { StatusDot, type StatusDotTone } from '@/components/ui/status-dot';
import { Text } from '@/components/ui/text';
import { type GatewayState, type InstanceStatus } from '@/lib/hooks/use-kiloclaw-queries';
import { cn } from '@/lib/utils';

type StatusValue = InstanceStatus | GatewayState | null | undefined;

const STATUS_TONES: Record<string, StatusDotTone> = {
  running: 'good',
  stopped: 'muted',
  provisioned: 'muted',
  starting: 'warn',
  restarting: 'warn',
  stopping: 'warn',
  destroying: 'danger',
  crashed: 'danger',
  shutting_down: 'warn',
};

const STATUS_LABELS: Record<string, string> = {
  running: 'RUNNING',
  stopped: 'STOPPED',
  provisioned: 'PROVISIONED',
  starting: 'STARTING',
  restarting: 'RESTARTING',
  stopping: 'STOPPING',
  destroying: 'DESTROYING',
  crashed: 'CRASHED',
  shutting_down: 'SHUTTING DOWN',
};

const TRANSITIONAL_STATUSES = new Set<string>([
  'starting',
  'restarting',
  'stopping',
  'shutting_down',
  'provisioned',
  'destroying',
]);

export function isTransitionalStatus(status: StatusValue | string): boolean {
  return status != null && TRANSITIONAL_STATUSES.has(status);
}

export function statusTone(status: StatusValue | string): StatusDotTone {
  return STATUS_TONES[status ?? ''] ?? 'muted';
}

export function statusLabel(status: StatusValue | string): string {
  return STATUS_LABELS[status ?? ''] ?? 'UNKNOWN';
}

export function StatusBadge({
  status,
  className,
}: Readonly<{ status: StatusValue; className?: string }>) {
  const tone = statusTone(status);
  const label = statusLabel(status);

  return (
    <View className={cn('flex-row items-center gap-1.5', className)}>
      <StatusDot tone={tone} glow />
      <Text variant="mono" className="text-[10px] uppercase tracking-[1px] text-muted-foreground">
        {label}
      </Text>
    </View>
  );
}
