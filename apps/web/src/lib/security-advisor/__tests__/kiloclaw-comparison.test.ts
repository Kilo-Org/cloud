import { describe, it, expect } from '@jest/globals';
import { findComparisonForCheckId, KILOCLAW_COMPARISON } from '../kiloclaw-comparison';

describe('findComparisonForCheckId', () => {
  it('returns the correct entry for a known checkId', () => {
    const result = findComparisonForCheckId('fs.config.perms_world_readable');
    expect(result).not.toBeNull();
    expect(result!.area).toBe('config_permissions');
    expect(result!.summary).toContain('owner only access');
  });

  it('returns the gateway exposure entry for net.gateway_exposed', () => {
    const result = findComparisonForCheckId('net.gateway_exposed');
    expect(result).not.toBeNull();
    expect(result!.area).toBe('gateway_exposure');
  });

  it('returns the authentication entry for auth.no_authentication', () => {
    const result = findComparisonForCheckId('auth.no_authentication');
    expect(result).not.toBeNull();
    expect(result!.area).toBe('authentication');
  });

  it('returns null for an unknown checkId', () => {
    const result = findComparisonForCheckId('totally.unknown.check');
    expect(result).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(findComparisonForCheckId('')).toBeNull();
  });

  it('every entry has required fields', () => {
    for (const entry of KILOCLAW_COMPARISON) {
      expect(entry.area).toBeTruthy();
      expect(entry.summary).toBeTruthy();
      expect(entry.detail).toBeTruthy();
      expect(entry.matchCheckIds.length).toBeGreaterThan(0);
    }
  });

  it('no checkId appears in multiple entries', () => {
    const seen = new Map<string, string>();
    for (const entry of KILOCLAW_COMPARISON) {
      for (const checkId of entry.matchCheckIds) {
        expect(seen.has(checkId)).toBe(false);
        seen.set(checkId, entry.area);
      }
    }
  });
});
