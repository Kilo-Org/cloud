import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { evictCapacityRegionFromKV, FLY_REGIONS_KV_KEY } from './regions';

type MockKv = {
  store: Map<string, string>;
  getMock: Mock;
  putMock: Mock;
  kv: KVNamespace;
};

function makeKv(initialValue: string | null = null): MockKv {
  const store = new Map<string, string>();
  if (initialValue !== null) {
    store.set(FLY_REGIONS_KV_KEY, initialValue);
  }
  const getMock = vi.fn(async (key: string) => store.get(key) ?? null);
  const putMock = vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  });
  const kv = {
    get: getMock,
    put: putMock,
    delete: vi.fn(),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
  return { store, getMock, putMock, kv };
}

const noopEnv: { KILOCLAW_AE?: AnalyticsEngineDataset } = {};

describe('evictCapacityRegionFromKV', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('is a no-op when KV read fails (no throw)', async () => {
    const getMock = vi.fn().mockRejectedValue(new Error('KV unavailable'));
    const putMock = vi.fn();
    const kv = { get: getMock, put: putMock } as unknown as KVNamespace;

    await expect(evictCapacityRegionFromKV(kv, noopEnv, 'iad')).resolves.toBeUndefined();
    expect(putMock).not.toHaveBeenCalled();
  });

  it('is a no-op when KV key is null', async () => {
    const { kv, putMock } = makeKv(null);
    await evictCapacityRegionFromKV(kv, noopEnv, 'iad');
    expect(putMock).not.toHaveBeenCalled();
  });

  it('is a no-op when KV key is empty string', async () => {
    const { kv, putMock } = makeKv('');
    await evictCapacityRegionFromKV(kv, noopEnv, 'iad');
    expect(putMock).not.toHaveBeenCalled();
  });

  it('is a no-op for a pure meta-region list', async () => {
    const { kv, putMock } = makeKv('eu,us');
    await evictCapacityRegionFromKV(kv, noopEnv, 'eu');
    expect(putMock).not.toHaveBeenCalled();
  });

  it('is a no-op when failedRegion is not in the list', async () => {
    const { kv, putMock } = makeKv('iad,dfw,ord');
    await evictCapacityRegionFromKV(kv, noopEnv, 'lhr');
    expect(putMock).not.toHaveBeenCalled();
  });

  it('evicts one region from a list with multiple remaining named regions', async () => {
    const { kv, putMock, store } = makeKv('iad,dfw,ord');
    await evictCapacityRegionFromKV(kv, noopEnv, 'iad');
    expect(putMock).toHaveBeenCalledWith(FLY_REGIONS_KV_KEY, 'dfw,ord');
    expect(store.get(FLY_REGIONS_KV_KEY)).toBe('dfw,ord');
  });

  it('preserves duplicate entries when multiple distinct named regions remain', async () => {
    const { kv, putMock } = makeKv('dfw,dfw,ord,iad');
    await evictCapacityRegionFromKV(kv, noopEnv, 'iad');
    // 2 distinct named regions remain (dfw, ord), so duplicates are preserved
    expect(putMock).toHaveBeenCalledWith(FLY_REGIONS_KV_KEY, 'dfw,dfw,ord');
  });

  it('falls back to meta when eviction leaves only one distinct named region (with duplicates)', async () => {
    // iad,dfw,dfw — evicting iad leaves dfw,dfw (only 1 distinct named region)
    const { kv, putMock, store } = makeKv('iad,dfw,dfw');
    await evictCapacityRegionFromKV(kv, noopEnv, 'iad');
    expect(putMock).toHaveBeenCalledWith(FLY_REGIONS_KV_KEY, 'dfw,eu,us');
    expect(store.get(FLY_REGIONS_KV_KEY)).toBe('dfw,eu,us');
  });

  it('writes "lastRegion,eu,us" when evicting the second-to-last named region', async () => {
    const { kv, putMock, store } = makeKv('iad,dfw');
    await evictCapacityRegionFromKV(kv, noopEnv, 'iad');
    expect(putMock).toHaveBeenCalledWith(FLY_REGIONS_KV_KEY, 'dfw,eu,us');
    expect(store.get(FLY_REGIONS_KV_KEY)).toBe('dfw,eu,us');
  });

  it('writes "eu,us" when evicting the only named region', async () => {
    const { kv, putMock, store } = makeKv('iad');
    await evictCapacityRegionFromKV(kv, noopEnv, 'iad');
    expect(putMock).toHaveBeenCalledWith(FLY_REGIONS_KV_KEY, 'eu,us');
    expect(store.get(FLY_REGIONS_KV_KEY)).toBe('eu,us');
  });

  it('writes "eu,us" when evicting the only named region mixed with meta-regions', async () => {
    // iad is the only named region, eu is meta — after evicting iad, no named regions remain
    const { kv, putMock } = makeKv('iad,eu');
    await evictCapacityRegionFromKV(kv, noopEnv, 'iad');
    expect(putMock).toHaveBeenCalledWith(FLY_REGIONS_KV_KEY, 'eu,us');
  });

  it('logs a warning after a successful eviction', async () => {
    const { kv } = makeKv('iad,dfw,ord');
    await evictCapacityRegionFromKV(kv, noopEnv, 'iad');
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('[regions] capacity eviction: removed iad')
    );
  });

  it('logs a revert-to-meta warning when last named region is evicted', async () => {
    const { kv } = makeKv('iad');
    await evictCapacityRegionFromKV(kv, noopEnv, 'iad');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('reverting to meta-regions'));
  });

  it('emits analytics event when KILOCLAW_AE binding is present', async () => {
    const writeDataPoint = vi.fn<(event: AnalyticsEngineDataPoint) => void>();
    const env = {
      KILOCLAW_AE: { writeDataPoint } as unknown as AnalyticsEngineDataset,
    };
    const { kv } = makeKv('iad,dfw,ord');
    await evictCapacityRegionFromKV(kv, env, 'iad');
    // writeEvent emits: blobs[0]=event, blobs[11]=flyRegion, blobs[12]=label
    const expectedDataPoint: AnalyticsEngineDataPoint = {
      blobs: [
        'region.capacity_eviction',
        '',
        'do',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        'iad',
        'evicted',
      ],
      doubles: [0, 0],
      indexes: ['region.capacity_eviction'],
    };
    expect(writeDataPoint).toHaveBeenCalledWith(expectedDataPoint);
  });

  it('emits "reverted_to_meta" label in analytics when last named region evicted', async () => {
    const writeDataPoint = vi.fn<(event: AnalyticsEngineDataPoint) => void>();
    const env = {
      KILOCLAW_AE: { writeDataPoint } as unknown as AnalyticsEngineDataset,
    };
    const { kv } = makeKv('iad');
    await evictCapacityRegionFromKV(kv, env, 'iad');
    const expectedDataPoint: AnalyticsEngineDataPoint = {
      blobs: [
        'region.capacity_eviction',
        '',
        'do',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        'iad',
        'reverted_to_meta',
      ],
      doubles: [0, 0],
      indexes: ['region.capacity_eviction'],
    };
    expect(writeDataPoint).toHaveBeenCalledWith(expectedDataPoint);
  });

  it('does not throw and logs a warning when KV put fails', async () => {
    const getMock = vi.fn().mockResolvedValue('iad,dfw');
    const putMock = vi.fn().mockRejectedValue(new Error('KV write error'));
    const kv = { get: getMock, put: putMock } as unknown as KVNamespace;

    await expect(evictCapacityRegionFromKV(kv, noopEnv, 'iad')).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to write updated region list to KV')
    );
  });

  it('does not emit analytics when KV put fails', async () => {
    const writeDataPoint = vi.fn<(event: AnalyticsEngineDataPoint) => void>();
    const env = {
      KILOCLAW_AE: { writeDataPoint } as unknown as AnalyticsEngineDataset,
    };
    const getMock = vi.fn().mockResolvedValue('iad,dfw');
    const putMock = vi.fn().mockRejectedValue(new Error('KV write error'));
    const kv = { get: getMock, put: putMock } as unknown as KVNamespace;

    await evictCapacityRegionFromKV(kv, env, 'iad');
    expect(writeDataPoint).not.toHaveBeenCalled();
  });
});
