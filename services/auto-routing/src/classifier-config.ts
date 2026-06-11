import { DEFAULT_CLASSIFIER_MODEL } from './classifier-prompt';

export const CLASSIFIER_MODEL_CONFIG_KEY = 'classifier_model';
export const DECISION_LOG_SAMPLE_RATE_CONFIG_KEY = 'decision_log_sample_rate';

// Successful decisions are high volume (~30/s) and only needed for latency
// and cache hit-rate percentiles, so they are sampled by default. The rate
// is a KV value so it can be changed without a redeploy; fallbacks and
// errors are always logged.
const DEFAULT_DECISION_LOG_SAMPLE_RATE = 0.05;

// KV propagation for config writes already takes up to 60s, so a 60s
// isolate-local cache adds no meaningful staleness while removing a KV
// read from every classification.
const CONFIG_CACHE_TTL_MS = 60_000;

let cachedClassifierModel: { model: string; expiresAt: number } | null = null;
let cachedDecisionLogSampleRate: { rate: number; expiresAt: number } | null = null;

type ClassifierConfigEnv = Pick<Env, 'AUTO_ROUTING_CONFIG'>;

export function clearClassifierConfigCache(): void {
  cachedClassifierModel = null;
  cachedDecisionLogSampleRate = null;
}

export async function getClassifierModel(env: ClassifierConfigEnv): Promise<string> {
  if (cachedClassifierModel && cachedClassifierModel.expiresAt > Date.now()) {
    return cachedClassifierModel.model;
  }

  const configuredModel = await env.AUTO_ROUTING_CONFIG.get(CLASSIFIER_MODEL_CONFIG_KEY);
  const trimmedModel = configuredModel?.trim();
  const model = trimmedModel && trimmedModel.length > 0 ? trimmedModel : DEFAULT_CLASSIFIER_MODEL;
  cachedClassifierModel = { model, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS };
  return model;
}

export async function getDecisionLogSampleRate(env: ClassifierConfigEnv): Promise<number> {
  if (cachedDecisionLogSampleRate && cachedDecisionLogSampleRate.expiresAt > Date.now()) {
    return cachedDecisionLogSampleRate.rate;
  }

  const configuredRate = await env.AUTO_ROUTING_CONFIG.get(DECISION_LOG_SAMPLE_RATE_CONFIG_KEY);
  const parsedRate = Number(configuredRate?.trim());
  const rate =
    configuredRate !== null && Number.isFinite(parsedRate) && parsedRate >= 0 && parsedRate <= 1
      ? parsedRate
      : DEFAULT_DECISION_LOG_SAMPLE_RATE;
  cachedDecisionLogSampleRate = { rate, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS };
  return rate;
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
  cachedClassifierModel = null;
  return trimmedModel;
}
