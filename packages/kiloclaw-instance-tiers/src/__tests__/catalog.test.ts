import { describe, expect, it } from 'vitest';
import {
  compareTierRank,
  canUpgradeTo,
  DEFAULT_INSTANCE_TIER,
  getTier,
  INSTANCE_TIERS,
  OFFERED_TIERS,
  resolveInstanceTypeLabel,
  tierFromMachineSize,
  tryInstanceTypeLabel,
} from '..';
import { InstanceTierSpecSchema } from '../types';

describe('instance tier catalog', () => {
  it('defines the default and offered tiers', () => {
    expect(DEFAULT_INSTANCE_TIER).toBe('perf-1-3');
    expect(OFFERED_TIERS).toEqual(['perf-1-3', 'perf-4-8', 'perf-4-16']);
    expect(getTier('perf-4-16')).toMatchObject({
      volumeSizeGb: 40,
      machineSize: { cpus: 4, memory_mb: 16384, cpu_kind: 'performance' },
    });
  });

  it('matches tiers by exact compute and volume shape', () => {
    expect(tierFromMachineSize({ cpus: 1, memory_mb: 3072, cpu_kind: 'performance' }, 10)).toBe(
      'perf-1-3'
    );
    expect(tierFromMachineSize({ cpus: 2, memory_mb: 3072, cpu_kind: 'shared' }, 10)).toBe(
      'shared-2-3'
    );
    expect(tierFromMachineSize({ cpus: 2, memory_mb: 4096, cpu_kind: 'shared' }, 10)).toBe(
      'shared-2-4'
    );
    expect(
      tierFromMachineSize({ cpus: 2, memory_mb: 4096, cpu_kind: 'performance' }, 10)
    ).toBeNull();
  });

  it('resolves labels with explicit custom and unknown semantics', () => {
    const customSize = { cpus: 2, memory_mb: 4096, cpu_kind: 'performance' } as const;
    expect(tryInstanceTypeLabel(customSize, 10)).toBeNull();
    expect(resolveInstanceTypeLabel(customSize, 10)).toBe('custom');
    expect(resolveInstanceTypeLabel(null, 10)).toBeNull();
  });

  it('ranks only offered tiers', () => {
    expect(compareTierRank('perf-4-8', 'perf-1-3')).toBeGreaterThan(0);
    expect(compareTierRank('perf-4-16', 'perf-4-8')).toBeGreaterThan(0);
    expect(() => compareTierRank('shared-2-3', 'perf-1-3')).toThrow(/offered tiers/);
  });

  it('keeps legacy tiers label-only', () => {
    expect(INSTANCE_TIERS['shared-2-3'].status).toBe('legacy');
    expect(INSTANCE_TIERS['shared-2-4'].status).toBe('legacy');
  });

  it('applies tier upgrade policy', () => {
    expect(
      canUpgradeTo({
        currentType: 'perf-1-3',
        currentSize: { cpus: 1, memory_mb: 3072, cpu_kind: 'performance' },
        currentVolumeSizeGb: 10,
        targetTier: 'perf-4-8',
      })
    ).toBe(true);
    expect(
      canUpgradeTo({
        currentType: 'perf-4-8',
        currentSize: { cpus: 4, memory_mb: 8192, cpu_kind: 'performance' },
        currentVolumeSizeGb: 20,
        targetTier: 'perf-1-3',
      })
    ).toBe(false);
    expect(
      canUpgradeTo({
        currentType: 'shared-2-4',
        currentSize: { cpus: 2, memory_mb: 4096, cpu_kind: 'shared' },
        currentVolumeSizeGb: 10,
        targetTier: 'perf-1-3',
      })
    ).toBe(false);
    expect(
      canUpgradeTo({
        currentType: 'custom',
        currentSize: { cpus: 1, memory_mb: 3072, cpu_kind: 'performance' },
        currentVolumeSizeGb: 10,
        targetTier: 'perf-1-3',
      })
    ).toBe(true);
    expect(
      canUpgradeTo({
        currentType: 'custom',
        currentSize: { cpus: 4, memory_mb: 16384, cpu_kind: 'performance' },
        currentVolumeSizeGb: 40,
        targetTier: 'perf-1-3',
      })
    ).toBe(false);
    expect(
      canUpgradeTo({
        currentType: 'custom',
        currentSize: null,
        currentVolumeSizeGb: 10,
        targetTier: 'shared-2-3',
      })
    ).toBe(false);
  });

  it('validates every catalog entry against the runtime schema', () => {
    for (const tier of Object.values(INSTANCE_TIERS)) {
      expect(() => InstanceTierSpecSchema.parse(tier)).not.toThrow();
    }
  });
});
