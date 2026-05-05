import { INSTANCE_TIERS } from './catalog';
import type { InstanceTierKey, InstanceTierSpec, MachineSize } from './types';

const OFFERED_RANKS: Partial<Record<InstanceTierKey, number>> = {
  'perf-1': 0,
  'perf-4-8': 1,
  'perf-4-16': 2,
};

export function getTier(key: InstanceTierKey): InstanceTierSpec {
  return INSTANCE_TIERS[key];
}

function normalizedCpuKind(size: MachineSize): 'shared' | 'performance' {
  return size.cpu_kind ?? 'shared';
}

function sameMachineSize(a: MachineSize, b: MachineSize): boolean {
  return (
    a.cpus === b.cpus &&
    a.memory_mb === b.memory_mb &&
    normalizedCpuKind(a) === normalizedCpuKind(b)
  );
}

export function tierFromMachineSize(
  size: MachineSize | null | undefined,
  volumeSizeGb: number | null | undefined
): InstanceTierKey | null {
  if (!size || !volumeSizeGb) return null;
  const match = Object.values(INSTANCE_TIERS).find(
    tier => tier.volumeSizeGb === volumeSizeGb && sameMachineSize(tier.machineSize, size)
  );
  return match?.key ?? null;
}

export function compareTierRank(a: InstanceTierKey, b: InstanceTierKey): number {
  const rankA = OFFERED_RANKS[a];
  const rankB = OFFERED_RANKS[b];
  if (rankA === undefined || rankB === undefined) {
    throw new Error('Tier rank is only defined for offered tiers');
  }
  return rankA - rankB;
}

export function isOfferedTier(key: InstanceTierKey): boolean {
  return INSTANCE_TIERS[key].status === 'offered';
}

export function formatTierHardware(tier: InstanceTierSpec): string {
  const cpuKind = tier.machineSize.cpu_kind ?? 'shared';
  const ramGb = tier.machineSize.memory_mb / 1024;
  const ramLabel = Number.isInteger(ramGb) ? String(ramGb) : String(ramGb.toFixed(1));
  return `${tier.machineSize.cpus}x ${cpuKind}, ${ramLabel} GB RAM, ${tier.volumeSizeGb} GB storage`;
}
