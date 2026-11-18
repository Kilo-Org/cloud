// jest.mock is hoisted above const declarations, so the mocks live inside the factory and the
// tests reach them through jest.requireMock, like kms-client.test.ts.
jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: {
    get: jest.fn(async () => {
      throw new Error('connection refused');
    }),
    set: jest.fn(async () => {
      throw new Error('connection refused');
    }),
    del: jest.fn(async () => {
      throw new Error('connection refused');
    }),
  },
}));

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import type { BYOKApiKeyEnvelope } from '@kilocode/db/schema-types';
import type { ByokKmsContext } from '@kilocode/web-shared/lib/ai-gateway/byok/kms-context';
import { cacheByokDataKey, evictCachedByokDataKey, getCachedByokDataKey } from './data-key-cache';
import { REPORT_WINDOW_MS } from '../report-window';

const mockRedis = jest.requireMock<{
  redisClient: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
}>('@kilocode/web-shared/lib/redis').redisClient;

const envelope: BYOKApiKeyEnvelope = {
  encrypted_data: { iv: 'iv', data: 'data', authTag: 'authTag' },
  wrapped_dek: 'wrapped-dek',
  kms_key_id: 'kms-key',
  kms_key_version: '1',
  algorithm: 'aes-256-gcm',
  envelope_version: 1,
};

const context: ByokKmsContext = {
  key_id: 'key-1',
  owner_type: 'user',
  owner_id: 'user-1',
  provider_id: 'openai',
};

let warn: jest.SpiedFunction<typeof console.warn>;

beforeEach(() => {
  jest.useFakeTimers();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockRedis.get.mockClear();
  mockRedis.set.mockClear();
  mockRedis.del.mockClear();
});

afterEach(() => {
  warn.mockRestore();
  jest.useRealTimers();
});

describe('byok data-key cache warnings', () => {
  test('logs a repeated read failure once per report window', async () => {
    // The window map is process-wide, so each test starts in its own report window.
    jest.setSystemTime(new Date('2031-01-01T00:00:00Z').getTime());
    const start = Date.now();
    await expect(getCachedByokDataKey(envelope, context)).resolves.toBeNull();
    await expect(getCachedByokDataKey(envelope, context)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[byok-data-key-cache] read failed', 'Error');

    jest.setSystemTime(start + REPORT_WINDOW_MS);
    await expect(getCachedByokDataKey(envelope, context)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith('[byok-data-key-cache] read failed', 'Error');
  });

  test('logs each cache operation under its own key', async () => {
    jest.setSystemTime(new Date('2031-02-01T00:00:00Z').getTime());
    await expect(getCachedByokDataKey(envelope, context)).resolves.toBeNull();
    await cacheByokDataKey(envelope, context, 'data-key');
    await evictCachedByokDataKey(envelope, context);
    // A second eviction inside the window is suppressed; the read, write and evict
    // windows ran out independently of each other.
    await evictCachedByokDataKey(envelope, context);

    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenNthCalledWith(1, '[byok-data-key-cache] read failed', 'Error');
    expect(warn).toHaveBeenNthCalledWith(2, '[byok-data-key-cache] write failed', 'Error');
    expect(warn).toHaveBeenLastCalledWith('[byok-data-key-cache] evict failed', 'Error');
  });
});
