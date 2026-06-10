import { DEFAULT_CLASSIFIER_MODEL } from './classifier-prompt';

export const CLASSIFIER_MODEL_CONFIG_KEY = 'classifier_model';

type ClassifierConfigEnv = Pick<Env, 'AUTO_ROUTING_CONFIG'>;

export async function getClassifierModel(env: ClassifierConfigEnv): Promise<string> {
  const configuredModel = await env.AUTO_ROUTING_CONFIG.get(CLASSIFIER_MODEL_CONFIG_KEY);
  const trimmedModel = configuredModel?.trim();

  return trimmedModel && trimmedModel.length > 0 ? trimmedModel : DEFAULT_CLASSIFIER_MODEL;
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
  return trimmedModel;
}
