import { formatError } from '@kilocode/worker-utils';
import { DEFAULT_CLASSIFIER_MODEL } from './classifier-prompt';
import { ttlCached } from './ttl-cache';

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

type ClassifierConfigEnv = Pick<Env, 'AUTO_ROUTING_CONFIG'>;

const classifierModelCache = ttlCached(CONFIG_CACHE_TTL_MS, async (env: ClassifierConfigEnv) => {
  const configuredModel = await env.AUTO_ROUTING_CONFIG.get(CLASSIFIER_MODEL_CONFIG_KEY);
  const trimmedModel = configuredModel?.trim();
  return trimmedModel && trimmedModel.length > 0 ? trimmedModel : DEFAULT_CLASSIFIER_MODEL;
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

export function getClassifierModel(env: ClassifierConfigEnv): Promise<string> {
  return classifierModelCache
    .get(env)
    .catch(failClosed(CLASSIFIER_MODEL_CONFIG_KEY, DEFAULT_CLASSIFIER_MODEL));
}

export function getDecisionLogSampleRate(env: ClassifierConfigEnv): Promise<number> {
  return decisionLogSampleRateCache
    .get(env)
    .catch(failClosed(DECISION_LOG_SAMPLE_RATE_CONFIG_KEY, DEFAULT_DECISION_LOG_SAMPLE_RATE));
}

export async function setClassifierModel(
  env: ClassifierConfigEnv,
  model: string
): Promise<string | null> {
  const trimmedModel = model.trim();
  if (trimmedModel.length === 0) {
    return null;
  }

  await env.AUTO_ROUTING_CONFIG.put(CLASSIFIER_MODEL_CONFIG_KEY, trimmedModel);
  classifierModelCache.clear();
  return trimmedModel;
}
