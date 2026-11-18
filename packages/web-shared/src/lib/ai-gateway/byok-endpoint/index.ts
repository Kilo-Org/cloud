import { randomInt } from 'node:crypto';
import {
  BYOK_ENDPOINT_PROVIDER_ID_PREFIX,
  ByokEndpointCredentialsSchema,
  getCustomLlmClientApiKind,
  isByokEndpointProviderId,
  type ByokEndpointCredentials,
  type ByokEndpointDefinition,
  type ByokEndpointModel,
  type ByokEndpointProviderId,
  type CustomLlmApiKind,
  type CustomLlmProvider,
  type ReasoningDetailsTransform,
} from '@kilocode/db/schema-types';

export { isByokEndpointProviderId, type ByokEndpointProviderId };

const PROVIDER_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const PROVIDER_ID_SUFFIX_LENGTH = 10;

export function generateByokEndpointProviderId(): ByokEndpointProviderId {
  let suffix = '';
  for (let i = 0; i < PROVIDER_ID_SUFFIX_LENGTH; i++) {
    suffix += PROVIDER_ID_ALPHABET[randomInt(PROVIDER_ID_ALPHABET.length)];
  }
  return `${BYOK_ENDPOINT_PROVIDER_ID_PREFIX}${suffix}`;
}

/** Whether a model id names an endpoint, such as `endpoint-a1b2c3d4e5/my-model`. */
export function isByokEndpointModelId(modelId: string): boolean {
  return parseByokEndpointModelId(modelId) !== null;
}

export function formatByokEndpointModelId(
  providerId: ByokEndpointProviderId,
  model: Pick<ByokEndpointModel, 'id'>
): string {
  return `${providerId}/${model.id}`;
}

export function parseByokEndpointModelId(
  modelId: string
): { providerId: ByokEndpointProviderId; modelId: string } | null {
  const slash = modelId.indexOf('/');
  if (slash === -1) return null;
  const providerId = modelId.slice(0, slash);
  if (!isByokEndpointProviderId(providerId)) return null;
  return { providerId, modelId: modelId.slice(slash + 1) };
}

/** The gateway APIs the endpoint serves `model` over. */
export function getByokEndpointModelApiKinds(
  definition: ByokEndpointDefinition,
  model: ByokEndpointModel
): CustomLlmApiKind[] {
  return model.api_kinds ?? definition.api_kinds;
}

export function getByokEndpointModelClientProvider(
  definition: ByokEndpointDefinition,
  model: ByokEndpointModel
): CustomLlmProvider {
  return model.client_provider ?? definition.client_provider;
}

export function getByokEndpointModelClientApiKind(
  definition: ByokEndpointDefinition,
  model: ByokEndpointModel
): CustomLlmApiKind {
  return getCustomLlmClientApiKind(getByokEndpointModelClientProvider(definition, model));
}

export function getByokEndpointModelResponseTransform(
  definition: ByokEndpointDefinition,
  model: ByokEndpointModel
): ReasoningDetailsTransform | null {
  const format = model.reasoning_format ?? definition.reasoning_format;
  return format === 'reasoning-details' ? null : format;
}

/** Whether requests for `model` keep the `prompt_cache_key` the gateway sets; off unless set. */
export function getByokEndpointModelSendsPromptCacheKey(
  definition: ByokEndpointDefinition,
  model: ByokEndpointModel
): boolean {
  return model.send_prompt_cache_key ?? definition.send_prompt_cache_key ?? false;
}

export function parseByokEndpointCredentials(decrypted: string): ByokEndpointCredentials | null {
  let json: unknown;
  try {
    json = JSON.parse(decrypted);
  } catch {
    return null;
  }
  return ByokEndpointCredentialsSchema.safeParse(json).data ?? null;
}
