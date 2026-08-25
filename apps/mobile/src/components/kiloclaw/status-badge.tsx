import { View } from 'react-native';

import { StatusDot, type StatusDotTone } from '@/components/ui/status-dot';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { type GatewayState, type InstanceStatus } from '@/lib/hooks/use-kiloclaw-queries';
import { cn } from '@/lib/utils';

type StatusValue = InstanceStatus | GatewayState | null | undefined;

// oxlint-disable-next-line anti-slop/no-known-value-widening -- statusTone() must look up an arbitrary backend status string, not just the known keys
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

const STATUS_LABELS = {
  running: 'kiloclaw.status.running',
  stopped: 'kiloclaw.status.stopped',
  provisioned: 'kiloclaw.status.provisioned',
  starting: 'kiloclaw.status.starting',
  restarting: 'kiloclaw.status.restarting',
  stopping: 'kiloclaw.status.stopping',
  destroying: 'kiloclaw.status.destroying',
  crashed: 'kiloclaw.status.crashed',
  shutting_down: 'kiloclaw.status.shuttingDown',
} as const;

/** Looks up a possibly-unknown key in a literal dictionary without widening its type. */
function lookup<V>(dictionary: Readonly<Record<string, V>>, key: string): V | undefined {
  return (dictionary as Readonly<Record<string, V | undefined>>)[key];
}

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
  return i18n.t(lookup(STATUS_LABELS, status ?? '') ?? 'kiloclaw.status.unknown');
}

export function StatusBadge({
  status,
  className,
}: Readonly<{ status: StatusValue | string; className?: string }>) {
  const tone = statusTone(status);
  const label = statusLabel(status);

  return (
    <View className={cn('flex-row items-center gap-1.5', className)}>
      <StatusDot tone={tone} />
      <Text variant="mono" className="text-[10px] uppercase tracking-[1px] text-muted-foreground">
        {label}
      </Text>
    </View>
  );
}
