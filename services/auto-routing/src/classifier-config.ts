import { formatError, ttlCached } from '@kilocode/worker-utils';
import {
  CLASSIFIER_WINNER_KV_KEY,
  ClassifierWinnerSchema,
  type ClassifierWinner,
} from '@kilocode/auto-routing-contracts';
import { DEFAULT_CLASSIFIER_MODEL } from '@kilocode/auto-routing-contracts/classifier';
import { kvReadThrough } from './kv-read-through';
import { fetchClassifierWinnerFromOrigin } from './benchmark-origin';

export const CLASSIFIER_MODEL_CONFIG_KEY = 'classifier_model';
export const DECISION_LOG_SAMPLE_RATE_CONFIG_KEY = 'decision_log_sample_rate';

// Successful decisions are high volume (~30/s) and only needed for latency
// and cache hit-rate percentiles, so they are sampled by default. The rate
// is a KV value so it can be changed without a redeploy; fallbacks and
// errors are always logged.
const DEFAULT_DECISION_LOG_SAMPLE_RATE = 0.01;

// KV propagation for config writes already takes up to 60s, so a 60s
// isolate-local cache adds no meaningful staleness while removing a KV
// read from every classification.
const CONFIG_CACHE_TTL_MS = 60_000;

type ClassifierConfigEnv = Pick<
  Env,
  'AUTO_ROUTING_CONFIG' | 'BENCHMARK_SERVICE' | 'INTERNAL_API_SECRET_PROD'
>;

export type ClassifierModelInfo = {
  // Effective model used by /decide: override ?? benchmark winner ?? default.
  model: string;
  override: string | null;
  benchmarkWinner: string | null;
};

function parseClassifierWinner(raw: string): ClassifierWinner | null {
  try {
    const parsed = ClassifierWinnerSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const classifierModelCache = ttlCached(CONFIG_CACHE_TTL_MS, async (env: ClassifierConfigEnv) => {
  const [configuredModel, winner] = await Promise.all([
    env.AUTO_ROUTING_CONFIG.get(CLASSIFIER_MODEL_CONFIG_KEY),
    kvReadThrough<ClassifierWinner>({
      kv: env.AUTO_ROUTING_CONFIG,
      key: CLASSIFIER_WINNER_KV_KEY,
      ttlSeconds: 3600,
      fetchOrigin: () => fetchClassifierWinnerFromOrigin(env),
      parse: parseClassifierWinner,
    }).catch((error: unknown) => {
      // A benchmark-origin failure must not reject the whole load: that would
      // discard a healthy admin override and fail closed to the default.
      console.warn(
        JSON.stringify({
          event: 'auto_routing_config_read_failed',
          key: CLASSIFIER_WINNER_KV_KEY,
          ...formatError(error),
        })
      );
      return null;
    }),
  ]);
  const override = configuredModel?.trim() || null;
  const benchmarkWinner = winner?.model ?? null;
  return {
    model: override ?? benchmarkWinner ?? DEFAULT_CLASSIFIER_MODEL,
    override,
    benchmarkWinner,
  } satisfies ClassifierModelInfo;
});

const decisionLogSampleRateCache = ttlCached(
  CONFIG_CACHE_TTL_MS,
  async (env: ClassifierConfigEnv) => {
    const configuredRate = await env.AUTO_ROUTING_CONFIG.get(DECISION_LOG_SAMPLE_RATE_CONFIG_KEY);
    const parsedRate = Number(configuredRate?.trim());
    return configuredRate !== null &&
      Number.isFinite(parsedRate) &&
      parsedRate >= 0 &&
      parsedRate <= 1
      ? parsedRate
      : DEFAULT_DECISION_LOG_SAMPLE_RATE;
  }
);

export function clearClassifierConfigCache(): void {
  classifierModelCache.clear();
  decisionLogSampleRateCache.clear();
}

// Config reads run before the guarded decision path. A transient KV failure
// must not turn a best-effort background classification into an HTTP 500, so
// reads fail closed to the documented default (logged for visibility). The
// rejected load is not cached — ttlCached evicts it — so the next request
// retries KV.
function failClosed<T>(key: string, fallback: T): (error: unknown) => T {
  return error => {
    console.warn(
      JSON.stringify({ event: 'auto_routing_config_read_failed', key, ...formatError(error) })
    );
    return fallback;
  };
}

const DEFAULT_CLASSIFIER_MODEL_INFO: ClassifierModelInfo = {
  model: DEFAULT_CLASSIFIER_MODEL,
  override: null,
  benchmarkWinner: null,
};

export function getClassifierModelInfo(env: ClassifierConfigEnv): Promise<ClassifierModelInfo> {
  return classifierModelCache
    .get(env)
    .catch(failClosed(CLASSIFIER_MODEL_CONFIG_KEY, DEFAULT_CLASSIFIER_MODEL_INFO));
}

export async function getClassifierModel(env: ClassifierConfigEnv): Promise<string> {
  return (await getClassifierModelInfo(env)).model;
}

export function getDecisionLogSampleRate(env: ClassifierConfigEnv): Promise<number> {
  return decisionLogSampleRateCache
    .get(env)
    .catch(failClosed(DECISION_LOG_SAMPLE_RATE_CONFIG_KEY, DEFAULT_DECISION_LOG_SAMPLE_RATE));
}

// model: null clears the admin override so the benchmark winner (or the
// built-in default) takes effect.
export async function setClassifierModel(
  env: ClassifierConfigEnv,
  model: string | null
): Promise<ClassifierModelInfo | null> {
  if (model === null) {
    await env.AUTO_ROUTING_CONFIG.delete(CLASSIFIER_MODEL_CONFIG_KEY);
    classifierModelCache.clear();
    return getClassifierModelInfo(env);
  }
  const trimmedModel = model.trim();
  if (trimmedModel.length === 0) {
    return null;
  }
  await env.AUTO_ROUTING_CONFIG.put(CLASSIFIER_MODEL_CONFIG_KEY, trimmedModel);
  classifierModelCache.clear();
  return getClassifierModelInfo(env);
}
