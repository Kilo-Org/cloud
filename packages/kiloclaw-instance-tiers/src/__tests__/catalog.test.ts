import { describe, expect, it } from 'vitest';
import {
  compareTierRank,
  DEFAULT_INSTANCE_TIER,
  getTier,
  INSTANCE_TIERS,
  OFFERED_TIERS,
  tierFromMachineSize,
} from '..';
import { InstanceTierSpecSchema } from '../types';

describe('instance tier catalog', () => {
  it('defines the default and offered tiers', () => {
    expect(DEFAULT_INSTANCE_TIER).toBe('perf-1');
    expect(OFFERED_TIERS).toEqual(['perf-1', 'perf-4-8', 'perf-4-16']);
    expect(getTier('perf-4-16')).toMatchObject({
      volumeSizeGb: 40,
      machineSize: { cpus: 4, memory_mb: 16384, cpu_kind: 'performance' },
    });
  });

  it('matches tiers by exact compute and volume shape', () => {
    expect(tierFromMachineSize({ cpus: 1, memory_mb: 3072, cpu_kind: 'performance' }, 10)).toBe(
      'perf-1'
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

  it('ranks only offered tiers', () => {
    expect(compareTierRank('perf-4-8', 'perf-1')).toBeGreaterThan(0);
    expect(compareTierRank('perf-4-16', 'perf-4-8')).toBeGreaterThan(0);
    expect(() => compareTierRank('shared-2-3', 'perf-1')).toThrow(/offered tiers/);
  });

  it('keeps legacy tiers label-only', () => {
    expect(INSTANCE_TIERS['shared-2-3'].status).toBe('legacy');
    expect(INSTANCE_TIERS['shared-2-4'].status).toBe('legacy');
  });

  it('validates every catalog entry against the runtime schema', () => {
    for (const tier of Object.values(INSTANCE_TIERS)) {
      expect(() => InstanceTierSpecSchema.parse(tier)).not.toThrow();
    }
  });
});
