import { DEFAULT_CLASSIFIER_MODEL } from './classifier-prompt';

export const CLASSIFIER_MODEL_CONFIG_KEY = 'classifier_model';

// KV propagation for config writes already takes up to 60s, so a 60s
// isolate-local cache adds no meaningful staleness while removing a KV
// read from every classification.
const CLASSIFIER_MODEL_CACHE_TTL_MS = 60_000;

let cachedClassifierModel: { model: string; expiresAt: number } | null = null;

type ClassifierConfigEnv = Pick<Env, 'AUTO_ROUTING_CONFIG'>;

export function clearClassifierModelCache(): void {
  cachedClassifierModel = null;
}

export async function getClassifierModel(env: ClassifierConfigEnv): Promise<string> {
  if (cachedClassifierModel && cachedClassifierModel.expiresAt > Date.now()) {
    return cachedClassifierModel.model;
  }

  const configuredModel = await env.AUTO_ROUTING_CONFIG.get(CLASSIFIER_MODEL_CONFIG_KEY);
  const trimmedModel = configuredModel?.trim();
  const model = trimmedModel && trimmedModel.length > 0 ? trimmedModel : DEFAULT_CLASSIFIER_MODEL;
  cachedClassifierModel = { model, expiresAt: Date.now() + CLASSIFIER_MODEL_CACHE_TTL_MS };
  return model;
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
