import { describe, it, expect } from 'vitest';
import {
  LEASE_TTL_MS,
  HEARTBEAT_INTERVAL_MS,
  STALE_THRESHOLD_MS,
  calculateExpiry,
  isExpired,
  isStale,
} from './lease.js';

describe('Lease Logic', () => {
  describe('constants', () => {
    it('should have LEASE_TTL_MS set to 90 seconds', () => {
      expect(LEASE_TTL_MS).toBe(90_000);
    });

    it('should have HEARTBEAT_INTERVAL_MS set to 30 seconds', () => {
      expect(HEARTBEAT_INTERVAL_MS).toBe(30_000);
    });

    it('should have STALE_THRESHOLD_MS set to 10 minutes', () => {
      expect(STALE_THRESHOLD_MS).toBe(10 * 60 * 1000);
    });
  });

  describe('calculateExpiry', () => {
    it('should return now + LEASE_TTL_MS', () => {
      const now = 1000000;
      expect(calculateExpiry(now)).toBe(now + LEASE_TTL_MS);
    });

    it('should use Date.now() when no argument provided', () => {
      const before = Date.now();
      const expiry = calculateExpiry();
      const after = Date.now();

      expect(expiry).toBeGreaterThanOrEqual(before + LEASE_TTL_MS);
      expect(expiry).toBeLessThanOrEqual(after + LEASE_TTL_MS);
    });
  });

  describe('isExpired', () => {
    it('should return true when now >= expiresAt', () => {
      expect(isExpired(1000, 1000)).toBe(true);
      expect(isExpired(1000, 1001)).toBe(true);
    });

    it('should return false when now < expiresAt', () => {
      expect(isExpired(1000, 999)).toBe(false);
    });

    it('should handle boundary correctly', () => {
      const expiresAt = 1000;
      expect(isExpired(expiresAt, expiresAt - 1)).toBe(false);
      expect(isExpired(expiresAt, expiresAt)).toBe(true);
      expect(isExpired(expiresAt, expiresAt + 1)).toBe(true);
    });
  });

  describe('isStale', () => {
    it('should return true when lastHeartbeat is undefined', () => {
      expect(isStale(undefined)).toBe(true);
    });

    it('should return true when time since lastHeartbeat > STALE_THRESHOLD_MS', () => {
      const now = 1000000;
      const lastHeartbeat = now - STALE_THRESHOLD_MS - 1;
      expect(isStale(lastHeartbeat, now)).toBe(true);
    });

    it('should return false when time since lastHeartbeat <= STALE_THRESHOLD_MS', () => {
      const now = 1000000;
      const lastHeartbeat = now - STALE_THRESHOLD_MS;
      expect(isStale(lastHeartbeat, now)).toBe(false);
    });

    it('should return false for recent heartbeat', () => {
      const now = 1000000;
      const lastHeartbeat = now - 1000; // 1 second ago
      expect(isStale(lastHeartbeat, now)).toBe(false);
    });
  });
});
