'use client';

import { Clock, Cpu, Globe, HardDrive, Hash } from 'lucide-react';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import { Separator } from '@/components/ui/separator';
import { DEFAULT_CLAW_INSTANCE_TYPE } from './claw.types';
import { DetailTile } from './DetailTile';
import { formatTs } from './time';

const PUBLIC_IP_DISPLAY = 'None';
const DISK_SIZE_DISPLAY = '20 GB';

export function InstanceTab({ status }: { status: KiloClawDashboardStatus }) {
  const details = [
    { label: 'Instance ID', value: status.sandboxId || 'N/A', icon: Hash, mono: true },
    {
      label: 'Instance Type',
      value: `${DEFAULT_CLAW_INSTANCE_TYPE.name} (${DEFAULT_CLAW_INSTANCE_TYPE.description})`,
      icon: Cpu,
      mono: false,
    },
    { label: 'Public IP', value: PUBLIC_IP_DISPLAY, icon: Globe, mono: true },
    { label: 'Disk Size', value: DISK_SIZE_DISPLAY, icon: HardDrive, mono: false },
    { label: 'Provisioned', value: formatTs(status.provisionedAt), icon: Clock, mono: false },
    { label: 'Last Started', value: formatTs(status.lastStartedAt), icon: Clock, mono: false },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {details.map(detail => (
          <DetailTile
            key={detail.label}
            label={detail.label}
            value={detail.value}
            icon={detail.icon}
            mono={detail.mono}
          />
        ))}
      </div>

      <Separator />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <DetailTile label="Env Vars" value={String(status.envVarCount)} icon={Hash} />
        <DetailTile label="Secrets" value={String(status.secretCount)} icon={Hash} />
        <DetailTile label="Channels" value={String(status.channelCount)} icon={Hash} />
      </div>
    </div>
  );
}
