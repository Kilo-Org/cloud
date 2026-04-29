import {
  Activity,
  Cpu,
  Globe,
  MapPin,
  MemoryStick,
  RotateCcw,
  Server,
  Sparkles,
} from 'lucide-react-native';
import { View } from 'react-native';

import { KvRow } from '@/components/ui/kv-row';
import { Text } from '@/components/ui/text';
import { type GatewayState } from '@/lib/hooks/use-kiloclaw-queries';

type StatusCardProps = {
  region: string | null | undefined;
  cpus: number | null | undefined;
  memoryMb: number | null | undefined;
  gatewayState: GatewayState | null | undefined;
  uptime: number | null | undefined;
  restarts: number | null | undefined;
  lastExitCode: number | null | undefined;
  lastExitSignal: string | null | undefined;
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

function formatLastExit(
  exitCode: number | null | undefined,
  exitSignal: string | null | undefined
): string {
  if (exitCode == null) {
    return exitSignal ?? '—';
  }
  const signalPart = exitSignal ? ` (${exitSignal})` : '';
  return `Code ${String(exitCode)}${signalPart}`;
}

export function StatusCard({
  region,
  cpus,
  memoryMb,
  gatewayState,
  uptime,
  restarts,
  lastExitCode,
  lastExitSignal,
  activeModel,
}: Readonly<StatusCardProps>) {
  const memoryLabel = memoryMb ? `${(memoryMb / 1024).toFixed(0)} GB` : '—';
  const cpuLabel = cpus ? `${String(cpus)} vCPU` : '—';
  const lastExitLabel = formatLastExit(lastExitCode, lastExitSignal);
  const gatewayLabel = gatewayState ?? '—';
  const uptimeLabel = uptime == null ? '—' : formatUptime(uptime);
  const restartsLabel = restarts == null ? '—' : String(restarts);
  const modelLabel = activeModel ?? '—';

  return (
    <View className="gap-3">
      <View className="overflow-hidden rounded-2xl border border-border bg-card px-4 pb-1 pt-3">
        <Text variant="eyebrow" className="mb-1">
          GATEWAY PROCESS
        </Text>
        <KvRow
          icon={Activity}
          label="State"
          value={gatewayLabel}
          valueTone={gatewayLabel === 'running' ? 'good' : 'default'}
        />
        <KvRow icon={Globe} label="Uptime" value={uptimeLabel} />
        <KvRow icon={RotateCcw} label="Restarts" value={restartsLabel} />
        <KvRow icon={Server} label="Last exit" value={lastExitLabel} />
        <KvRow icon={Sparkles} label="Model" value={modelLabel} valueTone="good" last />
      </View>

      <View className="overflow-hidden rounded-2xl border border-border bg-card px-4 pb-1 pt-3">
        <Text variant="eyebrow" className="mb-1">
          RESOURCES
        </Text>
        {region ? <KvRow icon={MapPin} label="Region" value={region} /> : null}
        <KvRow icon={Cpu} label="CPU" value={cpuLabel} />
        <KvRow icon={MemoryStick} label="Memory" value={memoryLabel} last />
      </View>
    </View>
  );
}
