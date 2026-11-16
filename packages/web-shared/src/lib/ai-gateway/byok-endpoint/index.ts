import { randomInt } from 'node:crypto';
import {
  BYOK_ENDPOINT_MODEL_PLACEHOLDER,
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
import type { DirectUpstreamAuth } from '@kilocode/web-shared/lib/ai-gateway/providers/build-direct-provider';
import { getGoogleServiceAccountAccessToken } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/google-service-account';
import { isUpstreamUrlPolicyEnforced } from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-url-policy';

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

export function hasByokEndpointModelPlaceholder(baseUrl: string): boolean {
  return baseUrl.includes(BYOK_ENDPOINT_MODEL_PLACEHOLDER);
}

/** The API root for `model`, with the `{model}` placeholder filled in. */
export function getByokEndpointModelBaseUrl(
  definition: Pick<ByokEndpointDefinition, 'base_url'>,
  model: Pick<ByokEndpointModel, 'internal_id'>
): string {
  return definition.base_url.replaceAll(
    BYOK_ENDPOINT_MODEL_PLACEHOLDER,
    encodeURIComponent(model.internal_id)
  );
}

/**
 * Endpoint URLs come from organization members rather than Kilo admins, so the HTTPS and
 * public-host policy applies on every deployed environment, including previews. Only local
 * development, which reaches local fakes over plain HTTP, is exempt.
 */
export function isByokEndpointUrlPolicyEnforced(): boolean {
  return isUpstreamUrlPolicyEnforced() || process.env.NODE_ENV === 'production';
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

export async function resolveByokEndpointAuth(
  credentials: ByokEndpointCredentials
): Promise<DirectUpstreamAuth> {
  switch (credentials.type) {
    case 'api_key':
      return { type: 'api_key', apiKey: credentials.api_key, apiKeyHeader: null };
    case 'x-api-key':
      return { type: 'api_key', apiKey: credentials.api_key, apiKeyHeader: 'x-api-key' };
    case 'service_account':
      return {
        type: 'api_key',
        apiKey: await getGoogleServiceAccountAccessToken(credentials),
        apiKeyHeader: null,
      };
    case 'aws_bedrock':
      return { type: 'aws_bedrock', credentials };
  }
}
