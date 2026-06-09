import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLASSIFIER_MODEL } from './classifier-prompt';
import { CLASSIFIER_MODEL_CONFIG_KEY, getClassifierModel } from './classifier-config';

function createKv(value: string | null) {
  const get = vi.fn(async () => value);
  return {
    kv: { get } as unknown as KVNamespace,
    get,
  };
}

describe('classifier config', () => {
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
        AUTO_ROUTING_CONFIG: createKv('  google/gemma-4-31b-it  ').kv,
      })
    ).resolves.toBe('google/gemma-4-31b-it');
  });

  it('falls back to the default classifier model when KV has a blank value', async () => {
    await expect(
      getClassifierModel({
        AUTO_ROUTING_CONFIG: createKv('   ').kv,
      })
    ).resolves.toBe(DEFAULT_CLASSIFIER_MODEL);
  });
});
