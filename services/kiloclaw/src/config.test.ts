import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MACHINE_GUEST,
  getDefaultMachineGuest,
  getProactiveRefreshThresholdMs,
  PROACTIVE_REFRESH_THRESHOLD_MS,
} from './config';
import { guestFromSize } from './durable-objects/machine-config';

describe('getProactiveRefreshThresholdMs', () => {
  it('returns default when no override', () => {
    expect(getProactiveRefreshThresholdMs(undefined)).toBe(PROACTIVE_REFRESH_THRESHOLD_MS);
  });

  it('returns default for empty string', () => {
    expect(getProactiveRefreshThresholdMs('')).toBe(PROACTIVE_REFRESH_THRESHOLD_MS);
  });

  it('converts hours to milliseconds', () => {
    expect(getProactiveRefreshThresholdMs('24')).toBe(24 * 60 * 60 * 1000);
  });

  it('handles fractional hours', () => {
    expect(getProactiveRefreshThresholdMs('0.5')).toBe(30 * 60 * 1000);
  });

  it('returns default for non-numeric string', () => {
    expect(getProactiveRefreshThresholdMs('abc')).toBe(PROACTIVE_REFRESH_THRESHOLD_MS);
  });

  it('returns default for zero', () => {
    expect(getProactiveRefreshThresholdMs('0')).toBe(PROACTIVE_REFRESH_THRESHOLD_MS);
  });

  it('returns default for negative value', () => {
    expect(getProactiveRefreshThresholdMs('-5')).toBe(PROACTIVE_REFRESH_THRESHOLD_MS);
  });

  it('accepts large values for testing', () => {
    expect(getProactiveRefreshThresholdMs('8760')).toBe(365 * 24 * 60 * 60 * 1000);
  });
});

describe('getDefaultMachineGuest', () => {
  it('returns the production default without development mode', () => {
    expect(
      getDefaultMachineGuest({
        WORKER_ENV: 'production',
        KILOCLAW_DEV_MACHINE_CPUS: '4',
        KILOCLAW_DEV_MACHINE_MEMORY_MB: '8192',
        KILOCLAW_DEV_MACHINE_CPU_KIND: 'performance',
      })
    ).toEqual(DEFAULT_MACHINE_GUEST);
  });

  it('uses valid development overrides', () => {
    expect(
      getDefaultMachineGuest({
        WORKER_ENV: 'development',
        KILOCLAW_DEV_MACHINE_CPUS: '4',
        KILOCLAW_DEV_MACHINE_MEMORY_MB: '8192',
        KILOCLAW_DEV_MACHINE_CPU_KIND: 'performance',
      })
    ).toEqual({ cpus: 4, memory_mb: 8192, cpu_kind: 'performance' });
  });

  it('falls back field-by-field for missing or invalid development overrides', () => {
    expect(
      getDefaultMachineGuest({
        WORKER_ENV: 'development',
        KILOCLAW_DEV_MACHINE_CPUS: '0',
        KILOCLAW_DEV_MACHINE_MEMORY_MB: '4096',
        KILOCLAW_DEV_MACHINE_CPU_KIND: 'turbo',
      })
    ).toEqual({ cpus: DEFAULT_MACHINE_GUEST.cpus, memory_mb: 4096, cpu_kind: 'shared' });
  });

  it('keeps explicit machineSize ahead of development defaults', () => {
    expect(
      guestFromSize(
        { cpus: 1, memory_mb: 1024, cpu_kind: 'shared' },
        {
          WORKER_ENV: 'development',
          KILOCLAW_DEV_MACHINE_CPUS: '4',
          KILOCLAW_DEV_MACHINE_MEMORY_MB: '8192',
          KILOCLAW_DEV_MACHINE_CPU_KIND: 'performance',
        }
      )
    ).toEqual({ cpus: 1, memory_mb: 1024, cpu_kind: 'shared' });
  });
});
