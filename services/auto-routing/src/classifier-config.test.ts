import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLASSIFIER_MODEL } from '@kilocode/auto-routing-contracts/classifier';
import {
  CLASSIFIER_MODEL_CONFIG_KEY,
  clearClassifierConfigCache,
  getClassifierModel,
  getClassifierModelInfo,
} from './classifier-config';
import { CLASSIFIER_WINNER_KV_KEY } from '@kilocode/auto-routing-contracts';

type ClassifierEnvStub = Pick<
  Env,
  'AUTO_ROUTING_CONFIG' | 'BENCHMARK_SERVICE' | 'INTERNAL_API_SECRET_PROD'
>;

const EXAMPLE_WINNER = {
  model: 'google/gemini-2.5-flash-lite',
  runId: 'run-abc',
  accuracy: 0.95,
  generatedAt: '2026-06-11T00:00:00.000Z',
};

type EnvSetup = {
  env: ClassifierEnvStub;
  configGet: ReturnType<typeof vi.fn>;
  configPut: ReturnType<typeof vi.fn>;
  benchmarkFetch: ReturnType<typeof vi.fn>;
};

function makeEnv(opts: {
  overrideModel?: string | null;
  winnerKvValue?: string | null;
  originWinner?: typeof EXAMPLE_WINNER | null;
  originStatus?: number;
  originThrow?: boolean;
  onPut?: (key: string, value: string, options: unknown) => void;
}): EnvSetup {
  const configGet = vi.fn(async (key: string) => {
    if (key === CLASSIFIER_MODEL_CONFIG_KEY) {
      return opts.overrideModel === undefined ? null : opts.overrideModel;
    }
    if (key === CLASSIFIER_WINNER_KV_KEY) {
      return opts.winnerKvValue === undefined ? null : opts.winnerKvValue;
    }
    return null;
  });
  const configPut = vi.fn(async (key: string, value: string, options: unknown) => {
    opts.onPut?.(key, value, options);
  });
  const benchmarkFetch = vi.fn(async () => {
    if (opts.originThrow) throw new Error('benchmark unavailable');
    return {
      ok: opts.originStatus === undefined ? true : opts.originStatus < 400,
      status: opts.originStatus ?? 200,
      json: async () => ({
        winner: opts.originWinner !== undefined ? opts.originWinner : null,
      }),
    };
  });

  const env: ClassifierEnvStub = {
    AUTO_ROUTING_CONFIG: {
      get: configGet,
      put: configPut,
    },
    BENCHMARK_SERVICE: {
      fetch: benchmarkFetch,
    },
    INTERNAL_API_SECRET_PROD: {
      get: vi.fn(async () => 'test-secret'),
    },
  } as unknown as ClassifierEnvStub;

  return { env, configGet, configPut, benchmarkFetch };
}

describe('classifier config', () => {
  beforeEach(() => {
    clearClassifierConfigCache();
  });

  it('falls back to the default classifier model when KV has no value', async () => {
    const { env, configGet } = makeEnv({});

    await expect(getClassifierModel(env)).resolves.toBe(DEFAULT_CLASSIFIER_MODEL);
    expect(configGet).toHaveBeenCalledWith(CLASSIFIER_MODEL_CONFIG_KEY);
  });

  it('uses the trimmed classifier model from KV override', async () => {
    const { env } = makeEnv({ overrideModel: '  google/gemini-2.5-flash-lite  ' });
    await expect(getClassifierModel(env)).resolves.toBe('google/gemini-2.5-flash-lite');
  });

  it('falls back to the default classifier model when KV has a blank value', async () => {
    const { env } = makeEnv({ overrideModel: '   ' });
    await expect(getClassifierModel(env)).resolves.toBe(DEFAULT_CLASSIFIER_MODEL);
  });

  it('fails closed to the default classifier model when the KV read rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const configGet = vi.fn(async () => {
      throw new Error('KV unavailable');
    });
    const env: ClassifierEnvStub = {
      AUTO_ROUTING_CONFIG: {
        get: configGet,
        put: vi.fn(async () => {}),
      } as unknown as KVNamespace,
      BENCHMARK_SERVICE: { fetch: vi.fn() } as unknown as Fetcher,
      INTERNAL_API_SECRET_PROD: {
        get: vi.fn(async () => 'secret'),
      } as unknown as SecretsStoreSecret,
    };

    await expect(getClassifierModel(env)).resolves.toBe(DEFAULT_CLASSIFIER_MODEL);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('serves the benchmark winner from KV without calling origin', async () => {
    const { env, benchmarkFetch } = makeEnv({ winnerKvValue: JSON.stringify(EXAMPLE_WINNER) });
    const info = await getClassifierModelInfo(env);
    expect(info.benchmarkWinner).toBe(EXAMPLE_WINNER.model);
    expect(info.model).toBe(EXAMPLE_WINNER.model);
    expect(benchmarkFetch).not.toHaveBeenCalled();
  });

  it('fetches from origin on winner KV miss, writes to KV with expirationTtl, and returns winner', async () => {
    const puts: Array<{ key: string; value: string; options: unknown }> = [];
    const { env } = makeEnv({
      winnerKvValue: null,
      originWinner: EXAMPLE_WINNER,
      onPut: (key, value, options) => puts.push({ key, value, options }),
    });

    const info = await getClassifierModelInfo(env);
    expect(info.benchmarkWinner).toBe(EXAMPLE_WINNER.model);
    expect(
      puts.some(
        p =>
          p.key === CLASSIFIER_WINNER_KV_KEY &&
          (p.options as { expirationTtl: number }).expirationTtl === 3600
      )
    ).toBe(true);
  });

  it('falls back to default model when origin returns null winner', async () => {
    const { env } = makeEnv({ winnerKvValue: null, originWinner: null });
    const info = await getClassifierModelInfo(env);
    expect(info.benchmarkWinner).toBeNull();
    expect(info.model).toBe(DEFAULT_CLASSIFIER_MODEL);
  });

  it('falls back to default model when origin fails for the winner', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env } = makeEnv({ winnerKvValue: null, originThrow: true });
    await expect(getClassifierModel(env)).resolves.toBe(DEFAULT_CLASSIFIER_MODEL);
    warn.mockRestore();
  });

  it('keeps a healthy admin override when the winner origin fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env } = makeEnv({ overrideModel: 'override/model', originThrow: true });
    expect(await getClassifierModelInfo(env)).toEqual({
      model: 'override/model',
      override: 'override/model',
      benchmarkWinner: null,
    });
    warn.mockRestore();
  });

  it('override takes precedence over benchmark winner from origin', async () => {
    const { env } = makeEnv({
      overrideModel: 'openai/gpt-4o',
      winnerKvValue: null,
      originWinner: EXAMPLE_WINNER,
    });
    const info = await getClassifierModelInfo(env);
    expect(info.override).toBe('openai/gpt-4o');
    expect(info.model).toBe('openai/gpt-4o');
  });
});
