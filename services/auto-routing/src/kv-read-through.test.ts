import { describe, expect, it, vi } from 'vitest';
import { kvReadThrough } from './kv-read-through';

function makeKv(value: string | null): { kv: KVNamespace; put: ReturnType<typeof vi.fn> } {
  const put = vi.fn(async () => {});
  const kv = {
    get: vi.fn(async () => value),
    put,
  } as unknown as KVNamespace;
  return { kv, put };
}

describe('kvReadThrough', () => {
  it('returns cached value on KV hit without calling origin', async () => {
    const value = { model: 'test/model', accuracy: 0.9 };
    const { kv, put } = makeKv(JSON.stringify(value));
    const fetchOrigin = vi.fn(async () => value);

    const result = await kvReadThrough({
      kv,
      key: 'test-key',
      ttlSeconds: 300,
      fetchOrigin,
      parse: raw => JSON.parse(raw) as typeof value,
    });

    expect(result).toEqual(value);
    expect(fetchOrigin).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it('treats a corrupt KV value as a miss, fetches from origin, and writes back with expirationTtl', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { kv, put } = makeKv('not valid json {{{');
    const origin = { model: 'origin/model', accuracy: 0.8 };
    const fetchOrigin = vi.fn(async () => origin);

    const result = await kvReadThrough({
      kv,
      key: 'corrupt-key',
      ttlSeconds: 3600,
      fetchOrigin,
      parse: raw => {
        try {
          return JSON.parse(raw) as typeof origin;
        } catch {
          return null;
        }
      },
    });

    expect(result).toEqual(origin);
    expect(fetchOrigin).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledWith('corrupt-key', JSON.stringify(origin), {
      expirationTtl: 3600,
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('fetches from origin on KV miss and writes back with expirationTtl', async () => {
    const { kv, put } = makeKv(null);
    const origin = { model: 'from/origin', accuracy: 0.95 };
    const fetchOrigin = vi.fn(async () => origin);

    const result = await kvReadThrough({
      kv,
      key: 'missing-key',
      ttlSeconds: 3600,
      fetchOrigin,
      parse: raw => JSON.parse(raw) as typeof origin,
    });

    expect(result).toEqual(origin);
    expect(fetchOrigin).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledWith('missing-key', JSON.stringify(origin), {
      expirationTtl: 3600,
    });
  });

  it('returns null and does NOT write to KV when origin returns null', async () => {
    const { kv, put } = makeKv(null);
    const fetchOrigin = vi.fn(async () => null);

    const result = await kvReadThrough({
      kv,
      key: 'empty-key',
      ttlSeconds: 3600,
      fetchOrigin,
      parse: raw => JSON.parse(raw) as Record<string, unknown>,
    });

    expect(result).toBeNull();
    expect(put).not.toHaveBeenCalled();
  });

  it('propagates origin errors without writing to KV', async () => {
    const { kv, put } = makeKv(null);
    const fetchOrigin = vi.fn(async () => {
      throw new Error('origin unavailable');
    });

    await expect(
      kvReadThrough({
        kv,
        key: 'throw-key',
        ttlSeconds: 3600,
        fetchOrigin,
        parse: raw => JSON.parse(raw) as Record<string, unknown>,
      })
    ).rejects.toThrow('origin unavailable');

    expect(put).not.toHaveBeenCalled();
  });
});
