import {
  Activity,
  Cpu,
  Globe,
  MapPin,
  MemoryStick,
  RotateCcw,
  Server,
  Sparkles,
} from '@/components/ui/icons';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { KvRow } from '@/components/ui/kv-row';
import { Text } from '@/components/ui/text';
import { statusLabel } from '@/components/kiloclaw/status-badge';
import { i18n } from '@/i18n';
import { formatDuration, formatNumber } from '@/lib/format';
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

function formatLastExit(
  exitCode: number | null | undefined,
  exitSignal: string | null | undefined
): string {
  if (exitCode == null) {
    return exitSignal ?? '—';
  }
  const signalPart = exitSignal ? ` (${exitSignal})` : '';
  return `${i18n.t('kiloclaw.status.exitCode', { code: String(exitCode) })}${signalPart}`;
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
  const { t } = useTranslation();
  const memoryLabel = memoryMb
    ? `${formatNumber(memoryMb / 1024, i18n.language, { maximumFractionDigits: 0 })} GB`
    : '—';
  const cpuLabel = cpus ? `${formatNumber(cpus, i18n.language)} vCPU` : '—';
  const lastExitLabel = formatLastExit(lastExitCode, lastExitSignal);
  const gatewayLabel = gatewayState ? statusLabel(gatewayState) : '—';
  const uptimeLabel = uptime == null ? '—' : formatDuration(uptime, i18n.language);
  const restartsLabel = restarts == null ? '—' : formatNumber(restarts, i18n.language);
  const modelLabel = activeModel ?? '—';

  return (
    <View className="gap-3">
      <View className="overflow-hidden rounded-2xl border border-border bg-card px-4 pb-1 pt-3">
        <Text variant="eyebrow" className="mb-1">
          {t('kiloclaw.status.gatewayProcess')}
        </Text>
        <KvRow
          icon={Activity}
          label={t('kiloclaw.status.state')}
          value={gatewayLabel}
          valueTone={gatewayState === 'running' ? 'good' : 'default'}
        />
        <KvRow icon={Globe} label={t('kiloclaw.status.uptime')} value={uptimeLabel} />
        <KvRow icon={RotateCcw} label={t('kiloclaw.status.restarts')} value={restartsLabel} />
        <KvRow icon={Server} label={t('kiloclaw.status.lastExit')} value={lastExitLabel} />
        <KvRow
          icon={Sparkles}
          label={t('kiloclaw.status.model')}
          value={modelLabel}
          valueTone="good"
          last
        />
      </View>

      <View className="overflow-hidden rounded-2xl border border-border bg-card px-4 pb-1 pt-3">
        <Text variant="eyebrow" className="mb-1">
          {t('kiloclaw.status.resources')}
        </Text>
        {region ? <KvRow icon={MapPin} label={t('kiloclaw.status.region')} value={region} /> : null}
        <KvRow icon={Cpu} label={t('kiloclaw.status.cpu')} value={cpuLabel} />
        <KvRow icon={MemoryStick} label={t('kiloclaw.status.memory')} value={memoryLabel} last />
      </View>
    </View>
  );
}
