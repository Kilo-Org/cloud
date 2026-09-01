import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { EnkryptVerificationSchema, EnkryptVerificationsSchema } from '@kilocode/db/schema-types';
import type * as EnkryptVerifications from './enkrypt-verifications';

let mockPublicationEnabled = true;
const mockWhere = jest.fn<Promise<{ verified_models: unknown }[]>, []>();
const mockFrom = jest.fn<{ where: typeof mockWhere }, [unknown]>(() => ({ where: mockWhere }));
const mockSelect = jest.fn<{ from: typeof mockFrom }, [unknown]>(() => ({ from: mockFrom }));
const mockReplicaSelect = jest.fn();

jest.mock('@/lib/config.server', () => ({
  get ENKRYPT_PUBLICATION_ENABLED() {
    return mockPublicationEnabled;
  },
}));

jest.mock('@/lib/drizzle', () => ({
  db: { select: mockSelect },
  readDb: { select: mockReplicaSelect },
}));

const verification = { checkedAt: '2026-08-30T00:00:00.000Z', scoreHash: 'a'.repeat(64) };
const verifications = { 'provider/model': verification };
let getEnkryptVerifications: typeof EnkryptVerifications.getEnkryptVerifications;

beforeEach(async () => {
  jest.resetModules();
  jest.clearAllMocks();
  mockWhere.mockReset();
  mockPublicationEnabled = true;
  jest.useFakeTimers();
  jest.setSystemTime(Date.parse(verification.checkedAt));
  ({ getEnkryptVerifications } = await import('./enkrypt-verifications'));
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('Enkrypt verification schemas', () => {
  it('preserves strict checks and a nonempty model-keyed map', () => {
    expect(EnkryptVerificationSchema.parse(verification)).toEqual(verification);
    expect(EnkryptVerificationsSchema.parse(verifications)).toEqual(verifications);
    expect(EnkryptVerificationsSchema.parse({})).toEqual({});
    expect(EnkryptVerificationsSchema.safeParse({ '': verification }).success).toBe(false);
  });

  it.each([
    undefined,
    null,
    {},
    { ...verification, checkedAt: '2026-08-30 00:00:00+00' },
    { ...verification, checkedAt: 'invalid' },
    { ...verification, checkedAt: null },
    { ...verification, scoreHash: 'A'.repeat(64) },
    { ...verification, scoreHash: 'g'.repeat(64) },
    { ...verification, scoreHash: 'a'.repeat(63) },
    { ...verification, scoreHash: 'a'.repeat(65) },
  ])('rejects malformed verification %j', value => {
    expect(EnkryptVerificationSchema.safeParse(value).success).toBe(false);
  });
});

describe('getEnkryptVerifications', () => {
  it('selects only verified_models from the primary state row once per five minutes', async () => {
    mockWhere.mockResolvedValue([{ verified_models: verifications }]);
    const first = await getEnkryptVerifications();
    expect(first).toEqual(verifications);
    expect(mockSelect).toHaveBeenCalledTimes(1);
    const { enkrypt_sync_state } = await import('@kilocode/db/schema');
    expect(mockSelect).toHaveBeenCalledWith({
      verified_models: enkrypt_sync_state.verified_models,
    });
    expect(mockFrom).toHaveBeenCalledWith(enkrypt_sync_state);
    expect(mockWhere).toHaveBeenCalledTimes(1);
    expect(mockReplicaSelect).not.toHaveBeenCalled();
    jest.advanceTimersByTime(5 * 60 * 1000 - 1);
    expect(await getEnkryptVerifications()).toBe(first);
    expect(mockWhere).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    await getEnkryptVerifications();
    expect(mockWhere).toHaveBeenCalledTimes(2);
  });

  it('shares a single pending verification query across concurrent readers', async () => {
    mockWhere.mockResolvedValue([{ verified_models: verifications }]);
    const results = await Promise.all([
      getEnkryptVerifications(),
      getEnkryptVerifications(),
      getEnkryptVerifications(),
    ]);
    expect(results).toEqual([verifications, verifications, verifications]);
    expect(mockWhere).toHaveBeenCalledTimes(1);
  });

  it('does not load the database or return a warm map while publication is disabled', async () => {
    mockPublicationEnabled = false;
    await expect(getEnkryptVerifications()).resolves.toEqual({});
    expect(mockSelect).not.toHaveBeenCalled();
    mockPublicationEnabled = true;
    mockWhere.mockResolvedValue([{ verified_models: verifications }]);
    await expect(getEnkryptVerifications()).resolves.toEqual(verifications);
    mockPublicationEnabled = false;
    jest.advanceTimersByTime(5 * 60 * 1000);
    await expect(getEnkryptVerifications()).resolves.toEqual({});
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('keeps valid entries individually without retaining unknown fields or mutating storage', async () => {
    const stored = Object.freeze({
      ...verifications,
      'provider/other': { ...verification, ignored: 'private' },
      'provider/invalid': { ...verification, scoreHash: 'invalid' },
      'provider/missing': null,
      '': verification,
    });
    mockWhere.mockResolvedValue([{ verified_models: stored }]);
    await expect(getEnkryptVerifications()).resolves.toEqual({
      ...verifications,
      'provider/other': verification,
    });
    expect(stored['provider/other']).toHaveProperty('ignored', 'private');
    expect(stored['provider/invalid'].scoreHash).toBe('invalid');
  });

  it.each([undefined, null, [], 'invalid', 1])(
    'returns an empty map for invalid stored maps %j',
    async value => {
      mockWhere.mockResolvedValue([{ verified_models: value }]);
      await expect(getEnkryptVerifications()).resolves.toEqual({});
    }
  );

  it('returns an empty map when the state row does not exist', async () => {
    mockWhere.mockResolvedValue([]);
    await expect(getEnkryptVerifications()).resolves.toEqual({});
  });

  it('falls back safely on database errors without exposing their messages, and retries', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warningLog = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockWhere.mockRejectedValueOnce(new Error('sensitive database error'));
    await expect(getEnkryptVerifications()).resolves.toEqual({});
    mockWhere.mockResolvedValueOnce([{ verified_models: verifications }]);
    const good = await getEnkryptVerifications();
    expect(good).toEqual(verifications);
    jest.advanceTimersByTime(5 * 60 * 1000);
    mockWhere.mockRejectedValueOnce(new Error('sensitive database error'));
    expect(await getEnkryptVerifications()).toBe(good);
    mockWhere.mockResolvedValueOnce([]);
    await expect(getEnkryptVerifications()).resolves.toEqual({});
    expect(mockWhere).toHaveBeenCalledTimes(4);
    expect(errorLog).not.toHaveBeenCalled();
    expect(warningLog).not.toHaveBeenCalled();
  });
});
