import {
  Activity,
  Cpu,
  Globe,
  type LucideIcon,
  MapPin,
  MemoryStick,
  Pencil,
  RotateCcw,
  Server,
  Sparkles,
} from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { StatusBadge } from '@/components/kiloclaw/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { type GatewayState, type InstanceStatus } from '@/lib/hooks/use-kiloclaw';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type StatusCardProps = {
  status: InstanceStatus | null | undefined;
  name: string | null | undefined;
  sandboxId: string | null | undefined;
  onRename?: () => void;
  region: string | null | undefined;
  cpus: number | null | undefined;
  memoryMb: number | null | undefined;
  gatewayState: GatewayState | null | undefined;
  uptime: number | null | undefined;
  restarts: number | null | undefined;
  lastExitCode: number | null | undefined;
  lastExitSignal: string | null | undefined;
  gatewayLoading?: boolean;
  activeModel?: string;
};

function formatUptime(seconds: number): string {
  if (seconds < 60) {
    return `${String(seconds)}s`;
  }
  if (seconds < 3600) {
    return `${String(Math.floor(seconds / 60))}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${String(h)}h ${String(m)}m`;
}

type DetailRowProps = {
  icon: LucideIcon;
  label: string;
  value: string;
  loading?: boolean;
};

function DetailRow({ icon: Icon, label, value, loading }: Readonly<DetailRowProps>) {
  const colors = useThemeColors();
  return (
    <View className="flex-row items-center gap-3 py-2">
      <Icon size={16} color={colors.mutedForeground} />
      <Text className="flex-1 text-sm text-muted-foreground">{label}</Text>
      {loading ? (
        <Skeleton className="h-4 w-16 rounded-sm bg-neutral-200 dark:bg-neutral-700" />
      ) : (
        <Text className="text-sm font-medium">{value}</Text>
      )}
    </View>
  );
}

function formatLastExit(
  exitCode: number | null | undefined,
  exitSignal: string | null | undefined
): string | null | undefined {
  if (exitCode == null) {
    return exitSignal;
  }
  const signalPart = exitSignal ? ` (${exitSignal})` : '';
  return `Code ${String(exitCode)}${signalPart}`;
}

export function StatusCard({
  status,
  name,
  sandboxId,
  onRename,
  region,
  cpus,
  memoryMb,
  gatewayState,
  uptime,
  restarts,
  lastExitCode,
  lastExitSignal,
  gatewayLoading,
  activeModel,
}: Readonly<StatusCardProps>) {
  const colors = useThemeColors();
  const memoryLabel = memoryMb ? `${(memoryMb / 1024).toFixed(0)} GB` : '—';
  const cpuLabel = cpus ? `${String(cpus)} vCPU` : '—';
  const lastExitLabel = formatLastExit(lastExitCode, lastExitSignal);

  return (
    <View className="rounded-lg bg-secondary p-4 gap-1">
      <View className="flex-row items-center justify-between gap-3 pb-2">
        <View className="flex-1 flex-row items-center gap-3">
          {onRename ? (
            <Pressable
              className="flex-row items-center gap-3 active:opacity-70"
              onPress={onRename}
              accessibilityLabel="Rename instance"
            >
              <Text className="shrink text-sm font-semibold" numberOfLines={1}>
                {name ?? sandboxId ?? 'Instance'}
              </Text>
              <Pencil size={14} color={colors.mutedForeground} />
            </Pressable>
          ) : (
            <Text className="shrink text-sm font-semibold" numberOfLines={1}>
              {name ?? sandboxId ?? 'Instance'}
            </Text>
          )}
        </View>
        <StatusBadge status={status} />
      </View>

      {region && <DetailRow icon={MapPin} label="Region" value={region} />}
      <DetailRow icon={Cpu} label="CPU" value={cpuLabel} />
      <DetailRow icon={MemoryStick} label="Memory" value={memoryLabel} />

      <View className="mt-2 border-t border-border pt-2 gap-1">
        <Text className="text-xs font-semibold text-muted-foreground pb-1">Gateway Process</Text>
        <DetailRow
          icon={Activity}
          label="State"
          value={gatewayState ?? '—'}
          loading={gatewayLoading}
        />
        <DetailRow
          icon={Globe}
          label="Uptime"
          value={uptime != null ? formatUptime(uptime) : '—'}
          loading={gatewayLoading}
        />
        <DetailRow
          icon={RotateCcw}
          label="Restarts"
          value={restarts != null ? String(restarts) : '—'}
          loading={gatewayLoading}
        />
        <DetailRow icon={Server} label="Last Exit" value={lastExitLabel ?? '—'} />
      </View>

      <View className="mt-2 border-t border-border pt-2 gap-1">
        <Text className="text-xs font-semibold text-muted-foreground pb-1">Active Model</Text>
        <DetailRow icon={Sparkles} label="Model" value={activeModel ?? '—'} />
      </View>
    </View>
  );
}
