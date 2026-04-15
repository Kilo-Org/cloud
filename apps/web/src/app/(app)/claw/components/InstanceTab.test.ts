import { describe, expect, test } from '@jest/globals';
import {
  formatUptime,
  formatBytes,
  formatVolumeUsage,
  getVolumeUsagePercent,
  getVolumeBarColor,
} from '@/lib/kiloclaw/instance-display';
import { hasVolumeUsageData } from './InstanceTab';

describe('formatUptime', () => {
  test.each([
    [0, '0m'],
    [300, '5m'],
    [3720, '1h 2m'],
    [90060, '1d 1h 1m'],
  ])('%i seconds → %s', (seconds, expected) => {
    expect(formatUptime(seconds)).toBe(expected);
  });
});

describe('formatBytes', () => {
  test.each([
    [0, '0 B'],
    [512, '512 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [1048576, '1.0 MB'],
    [1073741824, '1.0 GB'],
  ])('%i → %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe('formatVolumeUsage', () => {
  test('returns dash when either value is null', () => {
    expect(formatVolumeUsage(null, 1000)).toBe('—');
    expect(formatVolumeUsage(1000, null)).toBe('—');
  });

  test('formats usage with percentage', () => {
    expect(formatVolumeUsage(524288000, 1073741824)).toBe('500.0 MB of 1.0 GB (48.8%)');
  });

  test('omits decimal for whole-number percentages', () => {
    expect(formatVolumeUsage(1073741824, 1073741824)).toBe('1.0 GB of 1.0 GB (100%)');
  });
});

describe('getVolumeUsagePercent', () => {
  test('returns null for null inputs or zero total', () => {
    expect(getVolumeUsagePercent(null, 1000)).toBeNull();
    expect(getVolumeUsagePercent(1000, null)).toBeNull();
    expect(getVolumeUsagePercent(500, 0)).toBeNull();
  });

  test('calculates percentage', () => {
    expect(getVolumeUsagePercent(500, 1000)).toBe(50);
  });

  test('clamps to 0–100', () => {
    expect(getVolumeUsagePercent(-100, 1000)).toBe(0);
    expect(getVolumeUsagePercent(1500, 1000)).toBe(100);
  });
});

describe('getVolumeBarColor', () => {
  test.each([
    [null, 'bg-emerald-500'],
    [50, 'bg-emerald-500'],
    [75, 'bg-amber-500'],
    [90, 'bg-red-500'],
  ] as const)('percent=%s → %s', (percent, expected) => {
    expect(getVolumeBarColor(percent)).toBe(expected);
  });
});

describe('hasVolumeUsageData', () => {
  test.each([
    [null, null, false],
    [1000, null, false],
    [null, 2000, false],
    [1000, 2000, true],
  ])('diskUsed=%s diskTotal=%s → %s', (diskUsed, diskTotal, expected) => {
    expect(hasVolumeUsageData(diskUsed, diskTotal)).toBe(expected);
  });
});
