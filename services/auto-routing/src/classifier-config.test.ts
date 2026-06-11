import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLASSIFIER_MODEL } from './classifier-prompt';
import {
  CLASSIFIER_MODEL_CONFIG_KEY,
  clearClassifierConfigCache,
  getClassifierModel,
} from './classifier-config';

function createKv(value: string | null) {
  const get = vi.fn(async () => value);
  return {
    kv: { get } as unknown as KVNamespace,
    get,
  };
}

describe('classifier config', () => {
  beforeEach(() => {
    clearClassifierConfigCache();
  });

  it('falls back to the default classifier model when KV has no value', async () => {
    const { get, kv } = createKv(null);

    await expect(getClassifierModel({ AUTO_ROUTING_CONFIG: kv })).resolves.toBe(
      DEFAULT_CLASSIFIER_MODEL
    );
    expect(get).toHaveBeenCalledWith(CLASSIFIER_MODEL_CONFIG_KEY);
  });

  it('uses the trimmed classifier model from KV', async () => {
    await expect(
      getClassifierModel({
        AUTO_ROUTING_CONFIG: createKv('  google/gemini-2.5-flash-lite  ').kv,
      })
    ).resolves.toBe('google/gemini-2.5-flash-lite');
  });

  it('falls back to the default classifier model when KV has a blank value', async () => {
    await expect(
      getClassifierModel({
        AUTO_ROUTING_CONFIG: createKv('   ').kv,
      })
    ).resolves.toBe(DEFAULT_CLASSIFIER_MODEL);
  });

  it('fails closed to the default classifier model when the KV read rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const kv = {
      get: vi.fn(async () => {
        throw new Error('KV unavailable');
      }),
    } as unknown as KVNamespace;

    await expect(getClassifierModel({ AUTO_ROUTING_CONFIG: kv })).resolves.toBe(
      DEFAULT_CLASSIFIER_MODEL
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
