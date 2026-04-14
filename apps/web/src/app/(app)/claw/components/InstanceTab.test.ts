import { describe, expect, test } from '@jest/globals';
import {
  formatUptime,
  formatBytes,
  formatVolumeUsage,
  getVolumeUsagePercent,
  getVolumeBarColor,
  diskUsageQueryKey,
} from './InstanceTab';

describe('formatUptime', () => {
  test('formats minutes only', () => {
    expect(formatUptime(300)).toBe('5m');
  });

  test('formats hours and minutes', () => {
    expect(formatUptime(3720)).toBe('1h 2m');
  });

  test('formats days, hours, and minutes', () => {
    expect(formatUptime(90060)).toBe('1d 1h 1m');
  });

  test('formats zero as 0m', () => {
    expect(formatUptime(0)).toBe('0m');
  });
});

describe('formatBytes', () => {
  test('formats zero bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  test('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
  });

  test('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
  });

  test('formats megabytes', () => {
    expect(formatBytes(1048576)).toBe('1.0 MB');
  });

  test('formats gigabytes', () => {
    expect(formatBytes(1073741824)).toBe('1.0 GB');
  });

  test('formats fractional values', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
  });
});

describe('formatVolumeUsage', () => {
  test('returns dash when used is null', () => {
    expect(formatVolumeUsage(null, 1000)).toBe('—');
  });

  test('returns dash when total is null', () => {
    expect(formatVolumeUsage(1000, null)).toBe('—');
  });

  test('formats usage with percentage', () => {
    expect(formatVolumeUsage(524288000, 1073741824)).toBe('500.0 MB of 1.0 GB (48.8%)');
  });

  test('formats whole-number percentages without decimal', () => {
    expect(formatVolumeUsage(1073741824, 1073741824)).toBe('1.0 GB of 1.0 GB (100%)');
  });
});

describe('getVolumeUsagePercent', () => {
  test('returns null when used is null', () => {
    expect(getVolumeUsagePercent(null, 1000)).toBeNull();
  });

  test('returns null when total is null', () => {
    expect(getVolumeUsagePercent(1000, null)).toBeNull();
  });

  test('returns null when total is zero', () => {
    expect(getVolumeUsagePercent(500, 0)).toBeNull();
  });

  test('calculates percentage correctly', () => {
    expect(getVolumeUsagePercent(500, 1000)).toBe(50);
  });

  test('clamps to 100', () => {
    expect(getVolumeUsagePercent(1500, 1000)).toBe(100);
  });

  test('clamps to 0', () => {
    expect(getVolumeUsagePercent(-100, 1000)).toBe(0);
  });
});

describe('getVolumeBarColor', () => {
  test('returns emerald for null', () => {
    expect(getVolumeBarColor(null)).toBe('bg-emerald-500');
  });

  test('returns emerald for low usage', () => {
    expect(getVolumeBarColor(50)).toBe('bg-emerald-500');
  });

  test('returns amber for high usage', () => {
    expect(getVolumeBarColor(80)).toBe('bg-amber-500');
  });

  test('returns red for critical usage', () => {
    expect(getVolumeBarColor(95)).toBe('bg-red-500');
  });

  test('returns amber at exactly 75.1', () => {
    expect(getVolumeBarColor(75.1)).toBe('bg-amber-500');
  });

  test('returns emerald at exactly 75', () => {
    expect(getVolumeBarColor(75)).toBe('bg-amber-500');
  });

  test('returns red at exactly 90', () => {
    expect(getVolumeBarColor(90)).toBe('bg-red-500');
  });
});

describe('diskUsageQueryKey', () => {
  test('includes organization ID when provided', () => {
    expect(diskUsageQueryKey('org-123')).toEqual(['kiloclaw', 'disk-usage', 'org-123']);
  });

  test('uses "personal" when organizationId is undefined', () => {
    expect(diskUsageQueryKey(undefined)).toEqual(['kiloclaw', 'disk-usage', 'personal']);
  });

  test('different orgs produce different keys', () => {
    const keyA = diskUsageQueryKey('org-a');
    const keyB = diskUsageQueryKey('org-b');
    expect(keyA).not.toEqual(keyB);
  });

  test('org key differs from personal key', () => {
    const orgKey = diskUsageQueryKey('org-123');
    const personalKey = diskUsageQueryKey(undefined);
    expect(orgKey).not.toEqual(personalKey);
  });
});
