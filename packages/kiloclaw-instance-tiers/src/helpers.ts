import { DEFAULT_VOLUME_SIZE_GB, INSTANCE_TIERS } from './catalog';
import type { InstanceTierKey, InstanceTierSpec, InstanceType, MachineSize } from './types';

const OFFERED_RANKS: Partial<Record<InstanceTierKey, number>> = {
  'perf-1-3': 0,
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

export function tryInstanceTypeLabel(
  size: MachineSize | null | undefined,
  volumeSizeGb: number | null | undefined
): InstanceTierKey | null {
  return tierFromMachineSize(size, volumeSizeGb ?? DEFAULT_VOLUME_SIZE_GB);
}

export function resolveInstanceTypeLabel(
  size: MachineSize | null | undefined,
  volumeSizeGb: number | null | undefined
): InstanceType | null {
  if (!size) return null;
  return tryInstanceTypeLabel(size, volumeSizeGb) ?? 'custom';
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

export function isLegacyTier(key: InstanceTierKey): boolean {
  return INSTANCE_TIERS[key].status === 'legacy';
}

export function canUpgradeTo(args: {
  currentType: InstanceType | null;
  currentSize: MachineSize | null;
  currentVolumeSizeGb: number | null | undefined;
  targetTier: InstanceTierKey;
}): boolean {
  const target = getTier(args.targetTier);
  if (target.status !== 'offered') return false;

  if (args.currentType && args.currentType !== 'custom' && !isLegacyTier(args.currentType)) {
    return compareTierRank(args.targetTier, args.currentType) > 0;
  }

  const baseline = getTier('perf-1-3');
  const currentCpus = args.currentSize?.cpus ?? baseline.machineSize.cpus;
  const currentMemoryMb = args.currentSize?.memory_mb ?? baseline.machineSize.memory_mb;
  const currentVolumeSizeGb = args.currentVolumeSizeGb ?? DEFAULT_VOLUME_SIZE_GB;
  const currentCpuKind = args.currentSize ? normalizedCpuKind(args.currentSize) : 'performance';
  const targetCpuKind = normalizedCpuKind(target.machineSize);
  // A performance CPU is strictly stronger than a shared CPU, so a shared →
  // performance move is allowed regardless of CPU count.
  const cpusOk =
    (currentCpuKind === 'shared' && targetCpuKind === 'performance') ||
    target.machineSize.cpus >= currentCpus;
  return (
    cpusOk &&
    target.machineSize.memory_mb >= currentMemoryMb &&
    target.volumeSizeGb >= currentVolumeSizeGb
  );
}

export function formatTierHardware(tier: InstanceTierSpec): string {
  const cpuKind = tier.machineSize.cpu_kind ?? 'shared';
  const ramGb = tier.machineSize.memory_mb / 1024;
  const ramLabel = Number.isInteger(ramGb) ? String(ramGb) : String(ramGb.toFixed(1));
  return `${tier.machineSize.cpus}x ${cpuKind}, ${ramLabel} GB RAM, ${tier.volumeSizeGb} GB storage`;
}
