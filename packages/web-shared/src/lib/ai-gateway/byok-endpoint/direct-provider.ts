import type {
  ByokEndpointCredentials,
  ByokEndpointDefinition,
  ByokEndpointModel,
  ByokEndpointProviderId,
} from '@kilocode/db/schema-types';
import {
  getByokEndpointModelApiKinds,
  getByokEndpointModelClientApiKind,
  getByokEndpointModelResponseTransform,
  getByokEndpointModelSendsPromptCacheKey,
  parseByokEndpointCredentials,
} from '@kilocode/web-shared/lib/ai-gateway/byok-endpoint';
import { getGoogleServiceAccountAccessToken } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/google-service-account';
import {
  credentialHeaders,
  type DirectByokModel,
  type DirectByokProvider,
  type DirectByokUpstream,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import { getFallbackReasoningOptions } from '@kilocode/web-shared/lib/ai-gateway/providers/reasoning-options';

const ANTHROPIC_VERSION = '2023-06-01';

/** The stored endpoint credentials do not parse, so no request can authenticate. */
export class InvalidByokEndpointCredentialsError extends Error {
  constructor(providerId: ByokEndpointProviderId) {
    super(`Endpoint ${providerId} has invalid credentials`);
    this.name = 'InvalidByokEndpointCredentialsError';
  }
}

/** The user and session ids `applyTrackingIds` sets; `prompt_cache_key` is decided separately. */
function removeTrackingIds(body: Record<string, unknown>) {
  delete body.user;
  delete body.safety_identifier;
  delete body.session_id;
  const metadata = body.metadata;
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return;
  const { user_id: _userId, ...rest } = metadata as Record<string, unknown>;
  if (Object.keys(rest).length === 0) delete body.metadata;
  else body.metadata = rest;
}

function parseCredentials(
  providerId: ByokEndpointProviderId,
  credential: string
): ByokEndpointCredentials {
  const credentials = parseByokEndpointCredentials(credential);
  if (!credentials) throw new InvalidByokEndpointCredentialsError(providerId);
  return credentials;
}

/** A listed model of the endpoint: its id is the one clients use after the provider id. */
function toDirectByokModel(model: ByokEndpointModel): DirectByokModel {
  return {
    id: model.id,
    name: model.name ?? model.id,
    flags: model.flags,
    context_length: model.context_length,
    max_completion_tokens: model.max_completion_tokens,
    // In catalog mode the endpoint serves each model under the catalog id it is named after.
    catalog_model_id: model.id,
    reasoning_options: model.flags?.includes('reasoning')
      ? (getFallbackReasoningOptions(model.id) ?? getFallbackReasoningOptions(model.internal_id))
      : undefined,
  };
}

/** The upstream authentication for endpoint credentials. */
export async function resolveByokEndpointUpstreamAuth(
  credentials: ByokEndpointCredentials
): Promise<Pick<DirectByokUpstream, 'apiKey' | 'apiKeyHeader' | 'awsBedrock'>> {
  switch (credentials.type) {
    case 'api_key':
      return { apiKey: credentials.api_key, apiKeyHeader: null };
    case 'x-api-key':
      return { apiKey: credentials.api_key, apiKeyHeader: 'x-api-key' };
    case 'service_account':
      return {
        apiKey: await getGoogleServiceAccountAccessToken(credentials),
        apiKeyHeader: null,
      };
    case 'aws_bedrock':
      return { apiKey: '', apiKeyHeader: null, awsBedrock: credentials };
  }
}

function createProvider(
  providerId: ByokEndpointProviderId,
  definition: ByokEndpointDefinition
): DirectByokProvider {
  const endpointModels = new Map(definition.models.map(model => [model.id, model]));
  const models = definition.models.map(toDirectByokModel);
  const endpointModel = ({ id }: Pick<DirectByokModel, 'id'>) => {
    const model = endpointModels.get(id);
    if (!model) throw new Error(`Endpoint ${providerId} has no model ${id}`);
    return model;
  };
  return {
    id: providerId,
    organization_endpoint: { name: definition.name },
    models: async () => models,
    upstreamModelId: model => endpointModel(model).internal_id,
    getModelChatApi: model => getByokEndpointModelClientApiKind(definition, endpointModel(model)),
    getModelChatApis: model => getByokEndpointModelApiKinds(definition, endpointModel(model)),
    chatCompletionsHeaders: credentialHeaders,
    async resolveUpstream({ credential, model }) {
      const served = endpointModel(model);
      return {
        apiUrl: definition.base_url,
        apiUrlOverrides: {},
        disableUrlSuffix: false,
        ...(await resolveByokEndpointUpstreamAuth(parseCredentials(providerId, credential))),
        supportedChatApis: getByokEndpointModelApiKinds(definition, served),
        responseTransforms: getByokEndpointModelResponseTransform(definition, served),
      };
    },
    transformRequest({ request, extraHeaders }, model) {
      const body = request.body as Record<string, unknown>;
      // An organization's upstream has no use for the user and session ids Kilo adds.
      removeTrackingIds(body);
      if (!getByokEndpointModelSendsPromptCacheKey(definition, endpointModel(model))) {
        delete body.prompt_cache_key;
      }
      // Anthropic's own API rejects Messages requests without it; compatible upstreams ignore it.
      if (request.kind === 'messages') extraHeaders['anthropic-version'] ??= ANTHROPIC_VERSION;
    },
  };
}

const providersByDefinition = new WeakMap<ByokEndpointDefinition, DirectByokProvider>();

/**
 * The direct BYOK provider of an organization's endpoint key. Its models keep their listed ids,
 * and requests reach the upstream under each model's `internal_id`. It is built once per loaded
 * definition, so catalog lookups that cache per model list keep working.
 */
export function createByokEndpointDirectProvider(
  providerId: ByokEndpointProviderId,
  definition: ByokEndpointDefinition
): DirectByokProvider {
  let provider = providersByDefinition.get(definition);
  if (!provider) {
    provider = createProvider(providerId, definition);
    providersByDefinition.set(definition, provider);
  }
  return provider;
}
