import { randomInt } from 'node:crypto';
import {
  BYOK_PRIVATE_PROVIDER_ID_PREFIX,
  ByokPrivateProviderCredentialsSchema,
  getCustomLlmClientApiKind,
  isByokPrivateProviderId,
  type ByokPrivateProviderCredentials,
  type ByokPrivateProviderDefinition,
  type ByokPrivateModel,
  type ByokPrivateProviderId,
  type CustomLlmApiKind,
  type ReasoningDetailsTransform,
} from '@kilocode/db/schema-types';

export { isByokPrivateProviderId, type ByokPrivateProviderId };

const PROVIDER_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const PROVIDER_ID_SUFFIX_LENGTH = 10;

export function generateByokPrivateProviderId(): ByokPrivateProviderId {
  let suffix = '';
  for (let i = 0; i < PROVIDER_ID_SUFFIX_LENGTH; i++) {
    suffix += PROVIDER_ID_ALPHABET[randomInt(PROVIDER_ID_ALPHABET.length)];
  }
  return `${BYOK_PRIVATE_PROVIDER_ID_PREFIX}${suffix}`;
}

/** The private provider a model id such as `private-a1b2c3d4e5/my-model` names, if it names one. */
export function getByokPrivateProviderIdOfModel(modelId: string): ByokPrivateProviderId | null {
  const slash = modelId.indexOf('/');
  const providerId = slash === -1 ? null : modelId.slice(0, slash);
  return isByokPrivateProviderId(providerId) ? providerId : null;
}

/** Whether a model id names a private provider, such as `private-a1b2c3d4e5/my-model`. */
export function isByokPrivateModelId(modelId: string): boolean {
  return getByokPrivateProviderIdOfModel(modelId) !== null;
}

/** The gateway APIs the private provider serves `model` over. */
export function getByokPrivateModelApiKinds(
  definition: ByokPrivateProviderDefinition,
  model: ByokPrivateModel
): CustomLlmApiKind[] {
  return model.api_kinds ?? definition.api_kinds;
}

/** The gateway API clients use for `model`. */
export function getByokPrivateModelClientApiKind(
  definition: ByokPrivateProviderDefinition,
  model: ByokPrivateModel
): CustomLlmApiKind {
  return getCustomLlmClientApiKind(model.client_provider ?? definition.client_provider);
}

export function getByokPrivateModelResponseTransform(
  definition: ByokPrivateProviderDefinition,
  model: ByokPrivateModel
): ReasoningDetailsTransform | null {
  const format = model.reasoning_format ?? definition.reasoning_format;
  return format === 'reasoning-details' ? null : format;
}

/** Whether requests for `model` keep the `prompt_cache_key` the gateway sets; off unless set. */
export function getByokPrivateModelSendsPromptCacheKey(
  definition: ByokPrivateProviderDefinition,
  model: ByokPrivateModel
): boolean {
  return model.send_prompt_cache_key ?? definition.send_prompt_cache_key ?? false;
}

export function parseByokPrivateProviderCredentials(
  decrypted: string
): ByokPrivateProviderCredentials | null {
  let json: unknown;
  try {
    json = JSON.parse(decrypted);
  } catch {
    return null;
  }
  return ByokPrivateProviderCredentialsSchema.safeParse(json).data ?? null;
}
