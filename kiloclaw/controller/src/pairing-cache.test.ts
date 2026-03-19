import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createPairingCache,
  OPENCLAW_BIN,
  DEBOUNCE_DELAY_MS,
  PERIODIC_INTERVAL_MS,
  FAILURE_RETRY_BASE_MS,
  FAILURE_RETRY_MAX_MS,
  type ReadChannelPairingImpl,
  type ReadDevicePairingImpl,
} from './pairing-cache';

type ExecImpl = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

// Epoch-ms equivalent of the nowImpl ISO string, for TTL comparisons
const NOW_MS = new Date('2026-03-12T00:00:00.000Z').getTime();
// A timestamp 1 minute in the past — well within both TTLs
const RECENT_TS = NOW_MS - 60_000;

function createTestHarness(overrides?: {
  execImpl?: ExecImpl;
  readConfigImpl?: () => unknown;
  readChannelPairingImpl?: ReadChannelPairingImpl;
  readDevicePairingImpl?: ReadDevicePairingImpl;
}) {
  const execImpl = overrides?.execImpl ?? vi.fn<ExecImpl>();
  const readConfigImpl =
    overrides?.readConfigImpl ??
    vi.fn(() => ({
      channels: {
        telegram: { enabled: true, botToken: 'tok' },
        discord: { enabled: true, token: 'tok' },
      },
    }));
  const readChannelPairingImpl =
    overrides?.readChannelPairingImpl ??
    vi.fn<ReadChannelPairingImpl>().mockResolvedValue({ requests: [] });
  const readDevicePairingImpl =
    overrides?.readDevicePairingImpl ?? vi.fn<ReadDevicePairingImpl>().mockResolvedValue({});
  const nowImpl = vi.fn(() => '2026-03-12T00:00:00.000Z');
  const nowMsImpl = vi.fn(() => NOW_MS);

  const cache = createPairingCache({
    execImpl,
    readConfigImpl,
    readChannelPairingImpl,
    readDevicePairingImpl,
    nowImpl,
    nowMsImpl,
  });

  return {
    cache,
    execImpl,
    readConfigImpl,
    readChannelPairingImpl,
    readDevicePairingImpl,
    nowImpl,
    nowMsImpl,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-12T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createPairingCache', () => {
  describe('channel pairing list', () => {
    it('merges requests from multiple channels', async () => {
      const readChannelPairingImpl = vi.fn<ReadChannelPairingImpl>().mockImplementation(channel => {
        if (channel === 'telegram') {
          return Promise.resolve({
            requests: [{ code: 'ABC', id: '1', createdAt: new Date(RECENT_TS).toISOString() }],
          });
        }
        return Promise.resolve({
          requests: [{ code: 'DEF', id: '2', createdAt: new Date(RECENT_TS).toISOString() }],
        });
      });

      const { cache } = createTestHarness({ readChannelPairingImpl });
      await cache.refreshChannelPairing();

      const result = cache.getChannelPairing();
      expect(result.requests).toHaveLength(2);
      expect(result.requests[0]).toEqual({
        code: 'ABC',
        id: '1',
        channel: 'telegram',
        createdAt: new Date(RECENT_TS).toISOString(),
      });
      expect(result.requests[1]).toEqual({
        code: 'DEF',
        id: '2',
        channel: 'discord',
        createdAt: new Date(RECENT_TS).toISOString(),
      });
      expect(result.lastUpdated).toBe('2026-03-12T00:00:00.000Z');
    });

    it('returns empty list when config is unavailable', async () => {
      const readConfigImpl = vi.fn(() => {
        throw new Error('no config');
      });
      const readChannelPairingImpl = vi.fn<ReadChannelPairingImpl>();

      const { cache } = createTestHarness({ readChannelPairingImpl, readConfigImpl });
      await cache.refreshChannelPairing();

      expect(cache.getChannelPairing()).toEqual({ requests: [], lastUpdated: '' });
      expect(readChannelPairingImpl).not.toHaveBeenCalled();
    });

    it('handles per-channel failures with Promise.allSettled', async () => {
      const readChannelPairingImpl = vi.fn<ReadChannelPairingImpl>().mockImplementation(channel => {
        if (channel === 'telegram') {
          return Promise.reject(new Error('read failed'));
        }
        return Promise.resolve({
          requests: [{ code: 'DEF', id: '2', createdAt: new Date(RECENT_TS).toISOString() }],
        });
      });

      const { cache } = createTestHarness({ readChannelPairingImpl });
      await cache.refreshChannelPairing();

      const result = cache.getChannelPairing();
      // telegram had no prior data, so only discord's results appear
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]).toEqual({
        code: 'DEF',
        id: '2',
        channel: 'discord',
        createdAt: new Date(RECENT_TS).toISOString(),
      });
    });

    it('preserves stale data for a failed channel when it had prior cached requests', async () => {
      let telegramShouldFail = false;
      const readChannelPairingImpl = vi.fn<ReadChannelPairingImpl>().mockImplementation(channel => {
        if (channel === 'telegram' && telegramShouldFail) {
          return Promise.reject(new Error('read failed'));
        }
        if (channel === 'telegram') {
          return Promise.resolve({
            requests: [{ code: 'ABC', id: '1', createdAt: new Date(RECENT_TS).toISOString() }],
          });
        }
        return Promise.resolve({
          requests: [{ code: 'DEF', id: '2', createdAt: new Date(RECENT_TS).toISOString() }],
        });
      });

      const { cache } = createTestHarness({ readChannelPairingImpl });

      // First refresh: both channels succeed
      await cache.refreshChannelPairing();
      expect(cache.getChannelPairing().requests).toHaveLength(2);

      // Second refresh: telegram fails — its prior data should be preserved
      telegramShouldFail = true;
      await cache.refreshChannelPairing();

      const result = cache.getChannelPairing();
      expect(result.requests).toHaveLength(2);
      expect(result.requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'ABC', id: '1', channel: 'telegram' }),
          expect.objectContaining({ code: 'DEF', id: '2', channel: 'discord' }),
        ])
      );
    });

    it('logs WARNING prefix when a previously-successful channel fails', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      let callCount = 0;
      const readChannelPairingImpl = vi.fn<ReadChannelPairingImpl>().mockImplementation(channel => {
        callCount++;
        if (channel === 'telegram' && callCount > 1) {
          return Promise.reject(new Error('read down'));
        }
        return Promise.resolve({
          requests: [{ code: 'ABC', id: '1', createdAt: new Date(RECENT_TS).toISOString() }],
        });
      });
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({ readChannelPairingImpl, readConfigImpl });

      // First refresh: telegram succeeds and populates the cache
      await cache.refreshChannelPairing();
      expect(cache.getChannelPairing().requests).toHaveLength(1);

      // Second refresh: telegram fails — should log WARNING since it had prior data
      await cache.refreshChannelPairing();

      const calls = consoleWarnSpy.mock.calls.map(args => String(args[0]));
      const warnCall = calls.find(msg => msg.includes('WARNING: keeping stale data for'));
      expect(warnCall).toBeDefined();
      expect(warnCall).toContain('telegram');

      consoleWarnSpy.mockRestore();
    });

    it('logs no WARNING when failing channel had no prior data', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const readChannelPairingImpl = vi
        .fn<ReadChannelPairingImpl>()
        .mockRejectedValue(new Error('read down'));
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({ readChannelPairingImpl, readConfigImpl });

      // First refresh: telegram fails immediately (no prior data)
      await cache.refreshChannelPairing();

      const calls = consoleWarnSpy.mock.calls.map(args => String(args[0]));
      const warnCall = calls.find(msg => msg.includes('WARNING'));
      expect(warnCall).toBeUndefined();

      consoleWarnSpy.mockRestore();
    });

    it('returns cached data on subsequent calls without re-read', async () => {
      const readChannelPairingImpl = vi.fn<ReadChannelPairingImpl>().mockResolvedValue({
        requests: [{ code: 'A', id: '1', createdAt: new Date(RECENT_TS).toISOString() }],
      });

      const { cache } = createTestHarness({ readChannelPairingImpl });
      await cache.refreshChannelPairing();

      const first = cache.getChannelPairing();
      const second = cache.getChannelPairing();
      expect(first).toBe(second);
      // Only the initial refresh reads files; getChannelPairing is synchronous
      expect(readChannelPairingImpl).toHaveBeenCalledTimes(2); // once per channel
    });
  });

  describe('channel TTL filtering', () => {
    it('filters out entries with expired createdAt (> 60 min ago)', async () => {
      const expiredTs = NOW_MS - 61 * 60 * 1000; // 61 minutes ago
      const readChannelPairingImpl = vi.fn<ReadChannelPairingImpl>().mockImplementation(channel => {
        if (channel === 'telegram') {
          return Promise.resolve({
            requests: [
              { code: 'EXPIRED', id: 'e1', createdAt: new Date(expiredTs).toISOString() },
              { code: 'FRESH', id: 'f1', createdAt: new Date(RECENT_TS).toISOString() },
            ],
          });
        }
        return Promise.resolve({ requests: [] });
      });

      const { cache } = createTestHarness({ readChannelPairingImpl });
      await cache.refreshChannelPairing();

      const result = cache.getChannelPairing();
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0].code).toBe('FRESH');
    });

    it('filters out entries with invalid createdAt (empty string)', async () => {
      const readChannelPairingImpl = vi.fn<ReadChannelPairingImpl>().mockImplementation(channel => {
        if (channel === 'telegram') {
          return Promise.resolve({
            requests: [
              { code: 'EMPTY', id: 'e1', createdAt: '' },
              { code: 'FRESH', id: 'f1', createdAt: new Date(RECENT_TS).toISOString() },
            ],
          });
        }
        return Promise.resolve({ requests: [] });
      });

      const { cache } = createTestHarness({ readChannelPairingImpl });
      await cache.refreshChannelPairing();

      const result = cache.getChannelPairing();
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0].code).toBe('FRESH');
    });

    it('filters out entries with garbage createdAt (non-parseable string)', async () => {
      const readChannelPairingImpl = vi.fn<ReadChannelPairingImpl>().mockImplementation(channel => {
        if (channel === 'telegram') {
          return Promise.resolve({
            requests: [
              { code: 'GARBAGE', id: 'g1', createdAt: 'not-a-date' },
              { code: 'FRESH', id: 'f1', createdAt: new Date(RECENT_TS).toISOString() },
            ],
          });
        }
        return Promise.resolve({ requests: [] });
      });

      const { cache } = createTestHarness({ readChannelPairingImpl });
      await cache.refreshChannelPairing();

      const result = cache.getChannelPairing();
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0].code).toBe('FRESH');
    });

    it('keeps entry at exactly TTL boundary (not yet expired)', async () => {
      // Exactly at the boundary: nowMs - createdAt === TTL → NOT > TTL → keep
      const exactBoundaryTs = NOW_MS - 60 * 60 * 1000;
      const readChannelPairingImpl = vi.fn<ReadChannelPairingImpl>().mockImplementation(channel => {
        if (channel === 'telegram') {
          return Promise.resolve({
            requests: [
              { code: 'BOUNDARY', id: 'b1', createdAt: new Date(exactBoundaryTs).toISOString() },
            ],
          });
        }
        return Promise.resolve({ requests: [] });
      });

      const { cache } = createTestHarness({ readChannelPairingImpl });
      await cache.refreshChannelPairing();

      expect(cache.getChannelPairing().requests).toHaveLength(1);
      expect(cache.getChannelPairing().requests[0].code).toBe('BOUNDARY');
    });

    it('filters entry just past TTL boundary (just expired)', async () => {
      const justExpiredTs = NOW_MS - 60 * 60 * 1000 - 1;
      const readChannelPairingImpl = vi.fn<ReadChannelPairingImpl>().mockImplementation(channel => {
        if (channel === 'telegram') {
          return Promise.resolve({
            requests: [
              { code: 'EXPIRED', id: 'e1', createdAt: new Date(justExpiredTs).toISOString() },
            ],
          });
        }
        return Promise.resolve({ requests: [] });
      });

      const { cache } = createTestHarness({ readChannelPairingImpl });
      await cache.refreshChannelPairing();

      expect(cache.getChannelPairing().requests).toHaveLength(0);
    });

    it('passes through unknown fields from channel pairing requests (.passthrough())', async () => {
      const readChannelPairingImpl = vi.fn<ReadChannelPairingImpl>().mockImplementation(channel => {
        if (channel === 'telegram') {
          return Promise.resolve({
            requests: [
              {
                code: 'ABC',
                id: 'r1',
                meta: { foo: 1 },
                createdAt: new Date(RECENT_TS).toISOString(),
                extraField: 'forward-compat',
              },
            ],
          });
        }
        return Promise.resolve({ requests: [] });
      });

      const { cache } = createTestHarness({ readChannelPairingImpl });
      await cache.refreshChannelPairing();

      const result = cache.getChannelPairing();
      expect(result.requests).toHaveLength(1);
      // .passthrough() keeps unknown fields for forward compatibility
      expect((result.requests[0] as Record<string, unknown>)['extraField']).toBe('forward-compat');
    });
  });

  describe('device pairing list', () => {
    it('returns device requests with stripped publicKey', async () => {
      const readDevicePairingImpl = vi.fn<ReadDevicePairingImpl>().mockResolvedValue({
        r1: {
          requestId: 'r1',
          deviceId: 'd1',
          role: 'operator',
          platform: 'ios',
          clientId: 'c1',
          ts: RECENT_TS,
          publicKey: 'SHOULD_BE_STRIPPED',
        },
      });

      const { cache } = createTestHarness({ readDevicePairingImpl });
      await cache.refreshDevicePairing();

      const result = cache.getDevicePairing();
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]).toEqual({
        requestId: 'r1',
        deviceId: 'd1',
        role: 'operator',
        platform: 'ios',
        clientId: 'c1',
        ts: RECENT_TS,
      });
      expect(result.lastUpdated).toBe('2026-03-12T00:00:00.000Z');
      expect('publicKey' in result.requests[0]).toBe(false);
    });
  });

  describe('device TTL filtering', () => {
    it('filters out entries with expired ts (> 5 min ago)', async () => {
      const expiredTs = NOW_MS - 6 * 60 * 1000; // 6 minutes ago
      const readDevicePairingImpl = vi.fn<ReadDevicePairingImpl>().mockResolvedValue({
        expired: { requestId: 'r-expired', deviceId: 'd-expired', ts: expiredTs, publicKey: 'k' },
        fresh: { requestId: 'r-fresh', deviceId: 'd-fresh', ts: RECENT_TS, publicKey: 'k' },
      });

      const { cache } = createTestHarness({ readDevicePairingImpl });
      await cache.refreshDevicePairing();

      const result = cache.getDevicePairing();
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0].requestId).toBe('r-fresh');
    });

    it('preserves entries with missing ts (isUnexpiredDeviceRequest returns true when ts is undefined)', async () => {
      const readDevicePairingImpl = vi.fn<ReadDevicePairingImpl>().mockResolvedValue({
        // ts is intentionally absent — matches openclaw pruneExpiredPending behaviour
        missingTs: { requestId: 'r-missing', deviceId: 'd-missing', publicKey: 'k' },
      });

      const { cache } = createTestHarness({ readDevicePairingImpl });
      await cache.refreshDevicePairing();

      const result = cache.getDevicePairing();
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0].requestId).toBe('r-missing');
    });
  });

  describe('approveChannel', () => {
    it('runs CLI and refreshes cache on success', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({ stdout: '{}', stderr: '' });
      const { cache } = createTestHarness({ execImpl });

      const result = await cache.approveChannel('telegram', 'ABC123');

      expect(result).toEqual({ success: true, message: 'Pairing approved', statusHint: 200 });
      expect(execImpl).toHaveBeenCalledWith(OPENCLAW_BIN, [
        'pairing',
        'approve',
        'telegram',
        'ABC123',
        '--notify',
      ]);
      // approve call + refresh calls
      expect(execImpl.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it('rejects invalid channel name', async () => {
      const { cache } = createTestHarness();
      const result = await cache.approveChannel('INVALID!!', 'ABC');
      expect(result).toEqual({
        success: false,
        message: 'Invalid channel name',
        statusHint: 400,
      });
    });

    it('rejects invalid pairing code', async () => {
      const { cache } = createTestHarness();
      const result = await cache.approveChannel('telegram', 'bad code!!');
      expect(result).toEqual({
        success: false,
        message: 'Invalid pairing code',
        statusHint: 400,
      });
    });

    it('returns success when approve succeeds but post-approve refresh throws', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({ stdout: '{}', stderr: '' });
      const readChannelPairingImpl = vi
        .fn<ReadChannelPairingImpl>()
        .mockRejectedValue(new Error('refresh boom'));
      const { cache } = createTestHarness({ execImpl, readChannelPairingImpl });

      const result = await cache.approveChannel('telegram', 'ABC');
      expect(result).toEqual({ success: true, message: 'Pairing approved', statusHint: 200 });
    });

    it('returns error on CLI failure', async () => {
      const execImpl = vi.fn<ExecImpl>().mockRejectedValue(new Error('cli boom'));
      const { cache } = createTestHarness({ execImpl });

      const result = await cache.approveChannel('telegram', 'ABC');
      expect(result).toEqual({ success: false, message: 'cli boom', statusHint: 500 });
    });
  });

  describe('approveDevice', () => {
    it('runs CLI and refreshes cache on success', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({ stdout: '{}', stderr: '' });
      const { cache } = createTestHarness({ execImpl });

      const result = await cache.approveDevice('a1b2c3d4-e5f6-7890-abcd-ef1234567890');

      expect(result).toEqual({ success: true, message: 'Device approved', statusHint: 200 });
      expect(execImpl).toHaveBeenCalledWith(OPENCLAW_BIN, [
        'devices',
        'approve',
        'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      ]);
    });

    it('returns success when approve succeeds but post-approve refresh throws', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({ stdout: '{}', stderr: '' });
      const readDevicePairingImpl = vi
        .fn<ReadDevicePairingImpl>()
        .mockRejectedValue(new Error('refresh boom'));
      const { cache } = createTestHarness({ execImpl, readDevicePairingImpl });

      const result = await cache.approveDevice('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
      expect(result).toEqual({ success: true, message: 'Device approved', statusHint: 200 });
    });

    it('rejects non-UUID requestId', async () => {
      const { cache } = createTestHarness();
      const result = await cache.approveDevice('not-a-uuid');
      expect(result).toEqual({
        success: false,
        message: 'Invalid request ID',
        statusHint: 400,
      });
    });
  });

  describe('error handling', () => {
    it('returns last-known-good data on read failure after prior success', async () => {
      let callCount = 0;
      const readChannelPairingImpl = vi.fn<ReadChannelPairingImpl>().mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          // First refresh succeeds (two channels)
          return Promise.resolve({
            requests: [{ code: 'A', id: '1', createdAt: new Date(RECENT_TS).toISOString() }],
          });
        }
        return Promise.reject(new Error('read down'));
      });

      const { cache } = createTestHarness({ readChannelPairingImpl });

      await cache.refreshChannelPairing();
      const good = cache.getChannelPairing();
      expect(good.requests).toHaveLength(2);

      await cache.refreshChannelPairing();
      // Should still have the last-known-good data (both channels failed, so no update)
      // allSettled: all channels failed so anySuccess=false, cache not updated
      const after = cache.getChannelPairing();
      expect(after.requests).toHaveLength(2);
      expect(after.lastUpdated).toBe(good.lastUpdated);
    });

    it('returns empty list with empty lastUpdated when never fetched', () => {
      const { cache } = createTestHarness();
      expect(cache.getChannelPairing()).toEqual({ requests: [], lastUpdated: '' });
      expect(cache.getDevicePairing()).toEqual({ requests: [], lastUpdated: '' });
    });

    it('keeps device cache on read failure', async () => {
      let callCount = 0;
      const readDevicePairingImpl = vi.fn<ReadDevicePairingImpl>().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            r1: { requestId: 'r1', deviceId: 'd1', ts: RECENT_TS, publicKey: 'k' },
          });
        }
        return Promise.reject(new Error('fail'));
      });

      const readConfigImpl = vi.fn(() => ({ channels: {} }));
      const { cache } = createTestHarness({ readDevicePairingImpl, readConfigImpl });

      await cache.refreshDevicePairing();
      expect(cache.getDevicePairing().requests).toHaveLength(1);

      await cache.refreshDevicePairing();
      // Should keep last-known-good
      expect(cache.getDevicePairing().requests).toHaveLength(1);
    });

    it('ENOENT on device read → clears device cache to empty (file removed after last approval)', async () => {
      let callCount = 0;
      const readDevicePairingImpl = vi.fn<ReadDevicePairingImpl>().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            r1: { requestId: 'r1', deviceId: 'd1', ts: RECENT_TS },
          });
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });

      const readConfigImpl = vi.fn(() => ({ channels: {} }));
      const { cache } = createTestHarness({ readDevicePairingImpl, readConfigImpl });

      await cache.refreshDevicePairing();
      expect(cache.getDevicePairing().requests).toHaveLength(1);

      await cache.refreshDevicePairing();
      // ENOENT means file was removed → no pending requests, cache should be cleared
      expect(cache.getDevicePairing().requests).toHaveLength(0);
    });

    it('non-ENOENT cold-start channel failure → returns false (triggers backoff)', async () => {
      const readChannelPairingImpl = vi
        .fn<ReadChannelPairingImpl>()
        .mockRejectedValue(
          Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
        );
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({ readChannelPairingImpl, readConfigImpl });
      // refreshChannelPairingInternal returns false for non-ENOENT cold-start failures
      // so that backoff fires rather than silently treating the error as success
      await cache.refreshChannelPairing();

      // Cache stays empty — nothing to preserve
      expect(cache.getChannelPairing().requests).toHaveLength(0);

      // Verify backoff was armed: after a false return, consecutiveFailureCount > 0
      // which means nextAllowedRefreshAt is in the future. Start the cache and check
      // that a debounce triggered immediately after is skipped.
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      cache.start();
      await vi.advanceTimersByTimeAsync(0); // flush initial refresh (also fails → backoff set)
      cache.onPairingLogLine('pairing event');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_DELAY_MS);
      const skipped = consoleLogSpy.mock.calls.some(args =>
        String(args[0]).includes('debounced refresh skipped')
      );
      expect(skipped).toBe(true);
      consoleLogSpy.mockRestore();
      cache.cleanup();
    });

    it('ENOENT on first channel read → empty cache, no warning logged', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const readChannelPairingImpl = vi.fn<ReadChannelPairingImpl>().mockRejectedValue(enoentError);
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({ readChannelPairingImpl, readConfigImpl });
      await cache.refreshChannelPairing();

      // No warn at all — ENOENT with no prior data should be fully silent
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      // Cache should remain empty
      expect(cache.getChannelPairing().requests).toHaveLength(0);

      consoleWarnSpy.mockRestore();
    });

    it('ENOENT on subsequent channel read → stale cache preserved, warning logged', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      let callCount = 0;
      const readChannelPairingImpl = vi.fn<ReadChannelPairingImpl>().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            requests: [{ code: 'STALE', id: 's1', createdAt: new Date(RECENT_TS).toISOString() }],
          });
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({ readChannelPairingImpl, readConfigImpl });

      await cache.refreshChannelPairing();
      expect(cache.getChannelPairing().requests).toHaveLength(1);

      await cache.refreshChannelPairing();
      // Stale data preserved
      expect(cache.getChannelPairing().requests).toHaveLength(1);
      expect(cache.getChannelPairing().requests[0].code).toBe('STALE');

      const warnCalls = consoleWarnSpy.mock.calls.map(args => String(args[0]));
      expect(
        warnCalls.some(
          msg => msg.includes('WARNING: keeping stale data for') && msg.includes('telegram')
        )
      ).toBe(true);

      consoleWarnSpy.mockRestore();
    });
  });

  describe('periodic refresh', () => {
    it('fires immediately on start then refreshes every 120s', async () => {
      const readChannelPairingImpl = vi
        .fn<ReadChannelPairingImpl>()
        .mockResolvedValue({ requests: [] });
      const readDevicePairingImpl = vi.fn<ReadDevicePairingImpl>().mockResolvedValue({});
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({
        readChannelPairingImpl,
        readDevicePairingImpl,
        readConfigImpl,
      });
      cache.start();

      // Initial fetch fires immediately
      await vi.advanceTimersByTimeAsync(0);
      const readCalls = () =>
        readChannelPairingImpl.mock.calls.length + readDevicePairingImpl.mock.calls.length;
      const callsAfterInitial = readCalls();
      expect(callsAfterInitial).toBeGreaterThan(0);

      // Advance to periodic interval — periodic fires
      await vi.advanceTimersByTimeAsync(PERIODIC_INTERVAL_MS);
      expect(readCalls()).toBeGreaterThan(callsAfterInitial);

      const callsBefore = readCalls();

      // Advance another periodic interval — periodic fires again
      await vi.advanceTimersByTimeAsync(PERIODIC_INTERVAL_MS);
      expect(readCalls()).toBeGreaterThan(callsBefore);

      cache.cleanup();
    });
  });

  describe('initial fetch', () => {
    it('fires immediately on start', async () => {
      const readChannelPairingImpl = vi
        .fn<ReadChannelPairingImpl>()
        .mockResolvedValue({ requests: [] });
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({ readChannelPairingImpl, readConfigImpl });
      cache.start();

      // Flush the microtask queue so the fire-and-forget runPeriodicRefresh resolves
      await vi.advanceTimersByTimeAsync(0);
      expect(readChannelPairingImpl).toHaveBeenCalled();

      cache.cleanup();
    });
  });

  describe('debounced refresh', () => {
    it('fires 2s after first trigger', async () => {
      const readChannelPairingImpl = vi
        .fn<ReadChannelPairingImpl>()
        .mockResolvedValue({ requests: [] });
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({ readChannelPairingImpl, readConfigImpl });

      cache.onPairingLogLine('new pairing request received');

      expect(readChannelPairingImpl).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(readChannelPairingImpl).toHaveBeenCalled();
    });

    it('collapses burst into single refresh (non-sliding window)', async () => {
      const readChannelPairingImpl = vi
        .fn<ReadChannelPairingImpl>()
        .mockResolvedValue({ requests: [] });
      const readDevicePairingImpl = vi.fn<ReadDevicePairingImpl>().mockResolvedValue({});
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({
        readChannelPairingImpl,
        readDevicePairingImpl,
        readConfigImpl,
      });

      cache.onPairingLogLine('pairing event 1');
      await vi.advanceTimersByTimeAsync(500);
      cache.onPairingLogLine('pairing event 2');
      await vi.advanceTimersByTimeAsync(500);
      cache.onPairingLogLine('pairing event 3');

      // 1s has elapsed since first trigger, should not have fired yet
      const readCalls = () =>
        readChannelPairingImpl.mock.calls.length + readDevicePairingImpl.mock.calls.length;
      expect(readCalls()).toBe(0);

      // Advance to 2s from first trigger (1s more)
      await vi.advanceTimersByTimeAsync(1_000);
      expect(readCalls()).toBeGreaterThan(0);

      // Should only have fired once (channel + device refreshes)
      const callsAtFirstFire = readCalls();

      // After the debounce fires, a new trigger should work
      cache.onPairingLogLine('another pairing event');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(readCalls()).toBeGreaterThan(callsAtFirstFire);
    });

    it('ignores lines without pairing keywords', async () => {
      const readChannelPairingImpl = vi.fn<ReadChannelPairingImpl>();
      const { cache } = createTestHarness({ readChannelPairingImpl });

      cache.onPairingLogLine('some unrelated log output');
      await vi.advanceTimersByTimeAsync(5_000);

      expect(readChannelPairingImpl).not.toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('clears all timers so no further refreshes fire', async () => {
      const readChannelPairingImpl = vi
        .fn<ReadChannelPairingImpl>()
        .mockResolvedValue({ requests: [] });
      const readDevicePairingImpl = vi.fn<ReadDevicePairingImpl>().mockResolvedValue({});
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({
        readChannelPairingImpl,
        readDevicePairingImpl,
        readConfigImpl,
      });
      cache.start();

      // Flush the immediate initial refresh
      await vi.advanceTimersByTimeAsync(0);
      const readCalls = () =>
        readChannelPairingImpl.mock.calls.length + readDevicePairingImpl.mock.calls.length;
      const callsAfterInitial = readCalls();

      cache.onPairingLogLine('pairing event');
      cache.cleanup();

      await vi.advanceTimersByTimeAsync(120_000);
      // No additional calls beyond the initial refresh
      expect(readCalls()).toBe(callsAfterInitial);
    });
  });

  describe('lastUpdated', () => {
    it('is set on successful fetch and not updated on failure', async () => {
      let shouldFail = false;
      const readDevicePairingImpl = vi.fn<ReadDevicePairingImpl>().mockImplementation(() => {
        if (shouldFail) return Promise.reject(new Error('fail'));
        return Promise.resolve({
          r1: { requestId: 'r1', deviceId: 'd1', ts: RECENT_TS, publicKey: 'k' },
        });
      });
      const readConfigImpl = vi.fn(() => ({ channels: {} }));

      const { cache, nowImpl } = createTestHarness({ readDevicePairingImpl, readConfigImpl });

      nowImpl.mockReturnValue('2026-03-12T01:00:00.000Z');
      await cache.refreshDevicePairing();
      expect(cache.getDevicePairing().lastUpdated).toBe('2026-03-12T01:00:00.000Z');

      shouldFail = true;
      nowImpl.mockReturnValue('2026-03-12T02:00:00.000Z');
      await cache.refreshDevicePairing();
      // lastUpdated should NOT be updated
      expect(cache.getDevicePairing().lastUpdated).toBe('2026-03-12T01:00:00.000Z');
    });
  });

  describe('empty-field filtering', () => {
    it('filters out channel requests with empty code', async () => {
      const readChannelPairingImpl = vi.fn<ReadChannelPairingImpl>().mockImplementation(channel => {
        if (channel === 'telegram') {
          return Promise.resolve({
            requests: [
              { code: '', id: '1', createdAt: new Date(RECENT_TS).toISOString() },
              { code: 'ABC', id: '2', createdAt: new Date(RECENT_TS).toISOString() },
            ],
          });
        }
        return Promise.resolve({ requests: [] });
      });
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({ readChannelPairingImpl, readConfigImpl });
      await cache.refreshChannelPairing();

      const result = cache.getChannelPairing();
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0].code).toBe('ABC');
    });

    it('filters out channel requests with empty id', async () => {
      const readChannelPairingImpl = vi.fn<ReadChannelPairingImpl>().mockImplementation(channel => {
        if (channel === 'telegram') {
          return Promise.resolve({
            requests: [
              { code: 'ABC', id: '', createdAt: new Date(RECENT_TS).toISOString() },
              { code: 'DEF', id: '2', createdAt: new Date(RECENT_TS).toISOString() },
            ],
          });
        }
        return Promise.resolve({ requests: [] });
      });
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({ readChannelPairingImpl, readConfigImpl });
      await cache.refreshChannelPairing();

      const result = cache.getChannelPairing();
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0].code).toBe('DEF');
    });

    it('filters out device requests with empty requestId', async () => {
      const readDevicePairingImpl = vi.fn<ReadDevicePairingImpl>().mockResolvedValue({
        '': { requestId: '', deviceId: 'd1', ts: RECENT_TS, publicKey: 'k' },
        r2: { requestId: 'r2', deviceId: 'd2', ts: RECENT_TS, publicKey: 'k' },
      });

      const { cache } = createTestHarness({ readDevicePairingImpl });
      await cache.refreshDevicePairing();

      const result = cache.getDevicePairing();
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0].requestId).toBe('r2');
    });

    it('filters out device requests with empty deviceId', async () => {
      const readDevicePairingImpl = vi.fn<ReadDevicePairingImpl>().mockResolvedValue({
        r1: { requestId: 'r1', deviceId: '', ts: RECENT_TS, publicKey: 'k' },
        r2: { requestId: 'r2', deviceId: 'd2', ts: RECENT_TS, publicKey: 'k' },
      });

      const { cache } = createTestHarness({ readDevicePairingImpl });
      await cache.refreshDevicePairing();

      const result = cache.getDevicePairing();
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0].requestId).toBe('r2');
    });
  });

  describe('post-cleanup behavior', () => {
    it('refreshChannelPairing is a no-op after cleanup', async () => {
      const readChannelPairingImpl = vi
        .fn<ReadChannelPairingImpl>()
        .mockResolvedValue({ requests: [] });
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({ readChannelPairingImpl, readConfigImpl });
      cache.cleanup();

      await cache.refreshChannelPairing();
      expect(readChannelPairingImpl).not.toHaveBeenCalled();
    });

    it('refreshDevicePairing is a no-op after cleanup', async () => {
      const readDevicePairingImpl = vi.fn<ReadDevicePairingImpl>().mockResolvedValue({});

      const { cache } = createTestHarness({ readDevicePairingImpl });
      cache.cleanup();

      await cache.refreshDevicePairing();
      expect(readDevicePairingImpl).not.toHaveBeenCalled();
    });

    it('approveChannel returns 500 after cleanup', async () => {
      const execImpl = vi.fn<ExecImpl>();
      const { cache } = createTestHarness({ execImpl });
      cache.cleanup();

      const result = await cache.approveChannel('telegram', 'ABC123');
      expect(result).toEqual({
        success: false,
        message: 'Cache is shutting down',
        statusHint: 500,
      });
      expect(execImpl).not.toHaveBeenCalled();
    });

    it('approveDevice returns 500 after cleanup', async () => {
      const execImpl = vi.fn<ExecImpl>();
      const { cache } = createTestHarness({ execImpl });
      cache.cleanup();

      const result = await cache.approveDevice('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
      expect(result).toEqual({
        success: false,
        message: 'Cache is shutting down',
        statusHint: 500,
      });
      expect(execImpl).not.toHaveBeenCalled();
    });

    it('onPairingLogLine is ignored after cleanup', async () => {
      const readChannelPairingImpl = vi
        .fn<ReadChannelPairingImpl>()
        .mockResolvedValue({ requests: [] });
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({ readChannelPairingImpl, readConfigImpl });
      cache.cleanup();

      cache.onPairingLogLine('new pairing request received');
      await vi.advanceTimersByTimeAsync(5_000);

      expect(readChannelPairingImpl).not.toHaveBeenCalled();
    });
  });

  describe('detectChannels', () => {
    it('detects Slack with botToken', async () => {
      const readChannelPairingImpl = vi.fn<ReadChannelPairingImpl>().mockResolvedValue({
        requests: [{ code: 'A', id: '1', createdAt: new Date(RECENT_TS).toISOString() }],
      });
      const readConfigImpl = vi.fn(() => ({
        channels: {
          slack: { enabled: true, botToken: 'xoxb-tok' },
        },
      }));

      const { cache } = createTestHarness({ readChannelPairingImpl, readConfigImpl });
      await cache.refreshChannelPairing();

      expect(readChannelPairingImpl).toHaveBeenCalledWith('slack');
    });

    it('detects Slack with appToken only', async () => {
      const readChannelPairingImpl = vi.fn<ReadChannelPairingImpl>().mockResolvedValue({
        requests: [{ code: 'A', id: '1', createdAt: new Date(RECENT_TS).toISOString() }],
      });
      const readConfigImpl = vi.fn(() => ({
        channels: {
          slack: { enabled: true, appToken: 'xapp-tok' },
        },
      }));

      const { cache } = createTestHarness({ readChannelPairingImpl, readConfigImpl });
      await cache.refreshChannelPairing();

      expect(readChannelPairingImpl).toHaveBeenCalledWith('slack');
    });

    it('skips Slack when disabled even with tokens', async () => {
      const readChannelPairingImpl = vi.fn<ReadChannelPairingImpl>();
      const readConfigImpl = vi.fn(() => ({
        channels: {
          slack: { enabled: false, botToken: 'xoxb-tok' },
        },
      }));

      const { cache } = createTestHarness({ readChannelPairingImpl, readConfigImpl });
      await cache.refreshChannelPairing();

      expect(readChannelPairingImpl).not.toHaveBeenCalled();
    });

    it('clears stale channel cache when all channels are removed', async () => {
      const readChannelPairingImpl = vi.fn<ReadChannelPairingImpl>().mockResolvedValue({
        requests: [{ code: 'ABC', id: '1', createdAt: new Date(RECENT_TS).toISOString() }],
      });
      const configWithChannel: unknown = {
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      };
      const configNoChannels: unknown = { channels: {} };

      const readConfigImpl = vi.fn(() => configWithChannel);
      const { cache } = createTestHarness({ readChannelPairingImpl, readConfigImpl });

      // First refresh populates the cache
      await cache.refreshChannelPairing();
      expect(cache.getChannelPairing().requests).toHaveLength(1);

      // Remove all channels
      readConfigImpl.mockReturnValue(configNoChannels);
      await cache.refreshChannelPairing();

      // Cache should be cleared, not stale
      expect(cache.getChannelPairing().requests).toHaveLength(0);
      expect(cache.getChannelPairing().lastUpdated).not.toBe('');
    });
  });

  describe('concurrent refresh race', () => {
    it('stale refresh does not overwrite newer data (channel)', async () => {
      // Simulate: slow refresh starts, then a fast post-approve refresh
      // completes first with updated data.  The slow one must not clobber it.
      let resolveSlowChannel!: (v: unknown) => void;
      let callCount = 0;

      const readChannelPairingImpl = vi.fn<ReadChannelPairingImpl>().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First (slow) refresh — parks until we resolve manually
          return new Promise(resolve => {
            resolveSlowChannel = resolve;
          });
        }
        // Second (fast) refresh — returns immediately with post-approve data
        return Promise.resolve({ requests: [] });
      });

      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({ readChannelPairingImpl, readConfigImpl });

      // Start slow refresh (does not await)
      const slowPromise = cache.refreshChannelPairing();

      // Start fast refresh while slow is in-flight
      await cache.refreshChannelPairing();

      // Fast refresh completed: cache should be empty (approved request gone)
      expect(cache.getChannelPairing().requests).toHaveLength(0);

      // Now let the slow refresh finish with stale pre-approve data
      resolveSlowChannel({
        requests: [{ code: 'STALE', id: '99', createdAt: new Date(RECENT_TS).toISOString() }],
      });
      await slowPromise;

      // Cache must still reflect the newer (empty) result, NOT the stale data
      expect(cache.getChannelPairing().requests).toHaveLength(0);
    });

    it('stale refresh does not overwrite newer data (device)', async () => {
      let resolveSlowDevice!: (v: unknown) => void;
      let callCount = 0;

      const readDevicePairingImpl = vi.fn<ReadDevicePairingImpl>().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return new Promise(resolve => {
            resolveSlowDevice = resolve;
          });
        }
        return Promise.resolve({});
      });

      const { cache } = createTestHarness({ readDevicePairingImpl });

      const slowPromise = cache.refreshDevicePairing();
      await cache.refreshDevicePairing();

      expect(cache.getDevicePairing().requests).toHaveLength(0);

      resolveSlowDevice({ r1: { requestId: 'r1', deviceId: 'd1', ts: RECENT_TS, publicKey: 'k' } });
      await slowPromise;

      expect(cache.getDevicePairing().requests).toHaveLength(0);
    });
  });

  describe('start idempotency', () => {
    it('calling start twice does not create duplicate timers', async () => {
      const readChannelPairingImpl = vi
        .fn<ReadChannelPairingImpl>()
        .mockResolvedValue({ requests: [] });
      const readDevicePairingImpl = vi.fn<ReadDevicePairingImpl>().mockResolvedValue({});
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({
        readChannelPairingImpl,
        readDevicePairingImpl,
        readConfigImpl,
      });
      cache.start();
      cache.start(); // second call should be no-op

      // Flush the immediate initial refresh
      await vi.advanceTimersByTimeAsync(0);

      // With one channel (telegram): 1 readChannelPairingImpl call + 1 readDevicePairingImpl call
      // If start() wasn't idempotent, we'd see 4 calls
      expect(readChannelPairingImpl.mock.calls.length).toBe(1);
      expect(readDevicePairingImpl.mock.calls.length).toBe(1);

      cache.cleanup();
    });
  });

  describe('failure backoff', () => {
    it('uses exponential backoff and caps retries at 5 minutes', async () => {
      // Backoff only triggers when a read fails with stale data already in cache (return false).
      // Succeed once to populate the cache, then fail on every subsequent read.
      let readShouldFail = false;
      const readChannelPairingImpl = vi.fn<ReadChannelPairingImpl>().mockImplementation(() => {
        if (readShouldFail) return Promise.reject(new Error('read error'));
        return Promise.resolve({
          requests: [{ code: 'ABC', id: 'id1', createdAt: new Date(RECENT_TS).toISOString() }],
        });
      });
      const readDevicePairingImpl = vi.fn<ReadDevicePairingImpl>().mockResolvedValue({});
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({
        readChannelPairingImpl,
        readDevicePairingImpl,
        readConfigImpl,
      });
      cache.start();

      // First refresh fires immediately and succeeds, populating stale data into cache.
      await vi.advanceTimersByTimeAsync(0);
      expect(readChannelPairingImpl.mock.calls.length).toBeGreaterThan(0);

      // Make subsequent reads fail — cache has stale data so channel refresh returns false.
      readShouldFail = true;

      // Advance to first periodic interval — first failure fires.
      await vi.advanceTimersByTimeAsync(PERIODIC_INTERVAL_MS);
      const callsAfterFirstFailure = readChannelPairingImpl.mock.calls.length;
      expect(callsAfterFirstFailure).toBeGreaterThan(0);

      // Still within first failure backoff window, so no retry yet.
      await vi.advanceTimersByTimeAsync(FAILURE_RETRY_BASE_MS - 1);
      expect(readChannelPairingImpl.mock.calls.length).toBe(callsAfterFirstFailure);

      await vi.advanceTimersByTimeAsync(1);
      const callsAfterSecondFailure = readChannelPairingImpl.mock.calls.length;
      expect(callsAfterSecondFailure).toBeGreaterThan(callsAfterFirstFailure);

      // Second failure should back off longer (2x base).
      await vi.advanceTimersByTimeAsync(FAILURE_RETRY_BASE_MS * 2 - 1);
      expect(readChannelPairingImpl.mock.calls.length).toBe(callsAfterSecondFailure);

      await vi.advanceTimersByTimeAsync(1);
      const callsAfterThirdFailure = readChannelPairingImpl.mock.calls.length;
      expect(callsAfterThirdFailure).toBeGreaterThan(callsAfterSecondFailure);

      // Third failure backs off to 4x base.
      await vi.advanceTimersByTimeAsync(FAILURE_RETRY_BASE_MS * 4 - 1);
      expect(readChannelPairingImpl.mock.calls.length).toBe(callsAfterThirdFailure);

      await vi.advanceTimersByTimeAsync(1);
      const callsAfterFourthFailure = readChannelPairingImpl.mock.calls.length;
      expect(callsAfterFourthFailure).toBeGreaterThan(callsAfterThirdFailure);

      // Fourth failure backs off to 8x base.
      await vi.advanceTimersByTimeAsync(FAILURE_RETRY_BASE_MS * 8 - 1);
      expect(readChannelPairingImpl.mock.calls.length).toBe(callsAfterFourthFailure);

      await vi.advanceTimersByTimeAsync(1);
      const callsAfterFifthFailure = readChannelPairingImpl.mock.calls.length;
      expect(callsAfterFifthFailure).toBeGreaterThan(callsAfterFourthFailure);

      // Next delay should be capped at max (5 minutes), not continue doubling.
      await vi.advanceTimersByTimeAsync(FAILURE_RETRY_MAX_MS - 1);
      expect(readChannelPairingImpl.mock.calls.length).toBe(callsAfterFifthFailure);

      await vi.advanceTimersByTimeAsync(1);
      expect(readChannelPairingImpl.mock.calls.length).toBeGreaterThan(callsAfterFifthFailure);

      cache.cleanup();
    });
  });

  describe('input validation regexes', () => {
    it('rejects channel names starting with digit', async () => {
      const { cache } = createTestHarness();
      const result = await cache.approveChannel('1bad', 'ABC');
      expect(result.statusHint).toBe(400);
    });

    it('rejects channel names with uppercase', async () => {
      const { cache } = createTestHarness();
      const result = await cache.approveChannel('BadName', 'ABC');
      expect(result.statusHint).toBe(400);
    });

    it('rejects channel names longer than 64 chars', async () => {
      const { cache } = createTestHarness();
      const result = await cache.approveChannel('a' + 'b'.repeat(64), 'ABC');
      expect(result.statusHint).toBe(400);
    });

    it('accepts valid channel names', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({ stdout: '{}', stderr: '' });
      const { cache } = createTestHarness({ execImpl });
      const result = await cache.approveChannel('my-channel_1', 'ABC');
      expect(result.statusHint).toBe(200);
    });

    it('rejects codes with special characters', async () => {
      const { cache } = createTestHarness();
      const result = await cache.approveChannel('telegram', 'bad!code');
      expect(result.statusHint).toBe(400);
    });

    it('rejects codes longer than 32 chars', async () => {
      const { cache } = createTestHarness();
      const result = await cache.approveChannel('telegram', 'A'.repeat(33));
      expect(result.statusHint).toBe(400);
    });

    it('rejects empty code', async () => {
      const { cache } = createTestHarness();
      const result = await cache.approveChannel('telegram', '');
      expect(result.statusHint).toBe(400);
    });

    it('rejects malformed UUID', async () => {
      const { cache } = createTestHarness();
      const result = await cache.approveDevice('not-a-uuid-format');
      expect(result.statusHint).toBe(400);
    });

    it('accepts valid UUID', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({ stdout: '{}', stderr: '' });
      const { cache } = createTestHarness({ execImpl });
      const result = await cache.approveDevice('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
      expect(result.statusHint).toBe(200);
    });

    it('accepts uppercase UUID', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({ stdout: '{}', stderr: '' });
      const { cache } = createTestHarness({ execImpl });
      const result = await cache.approveDevice('A1B2C3D4-E5F6-7890-ABCD-EF1234567890');
      expect(result.statusHint).toBe(200);
    });
  });
});
