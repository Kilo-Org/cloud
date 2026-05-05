import type { InstanceTierKey, InstanceTierSpec } from './types';

// Tier lifecycle rules: keys are append-only, hardware shapes are immutable,
// deprecated selectable tiers become `legacy`, and retired keys are removed only
// after no active Postgres rows reference them.
const INSTANCE_TIERS_RAW = {
  'perf-1-3': {
    key: 'perf-1-3',
    label: 'perf-1-3',
    machineSize: { cpus: 1, memory_mb: 3072, cpu_kind: 'performance' },
    volumeSizeGb: 10,
    status: 'offered',
  },
  'perf-4-8': {
    key: 'perf-4-8',
    label: 'perf-4-8',
    machineSize: { cpus: 4, memory_mb: 8192, cpu_kind: 'performance' },
    volumeSizeGb: 20,
    status: 'offered',
  },
  'perf-4-16': {
    key: 'perf-4-16',
    label: 'perf-4-16',
    machineSize: { cpus: 4, memory_mb: 16384, cpu_kind: 'performance' },
    volumeSizeGb: 40,
    status: 'offered',
  },
  'shared-2-3': {
    key: 'shared-2-3',
    label: 'shared-2-3',
    machineSize: { cpus: 2, memory_mb: 3072, cpu_kind: 'shared' },
    volumeSizeGb: 10,
    status: 'legacy',
  },
  'shared-2-4': {
    key: 'shared-2-4',
    label: 'shared-2-4',
    machineSize: { cpus: 2, memory_mb: 4096, cpu_kind: 'shared' },
    volumeSizeGb: 10,
    status: 'legacy',
  },
} as const satisfies Record<InstanceTierKey, InstanceTierSpec>;

export const INSTANCE_TIERS: Readonly<Record<InstanceTierKey, InstanceTierSpec>> =
  INSTANCE_TIERS_RAW;

export const DEFAULT_INSTANCE_TIER: InstanceTierKey = 'perf-1-3';

export const DEFAULT_VOLUME_SIZE_GB = 10;

export const OFFERED_TIERS: readonly InstanceTierKey[] = Object.values(INSTANCE_TIERS)
  .filter(tier => tier.status === 'offered')
  .map(tier => tier.key);

export const INSTANCE_TYPE_VALUES = [...Object.keys(INSTANCE_TIERS), 'custom'] as const;
