import type {
  ByokEndpointDefinition,
  ByokEndpointModel,
  ByokEndpointProviderId,
} from '@kilocode/db/schema-types';
import {
  getByokEndpointModelApiKinds,
  getByokEndpointModelClientApiKind,
  getByokEndpointModelResponseTransform,
  parseByokEndpointCredentials,
  resolveByokEndpointAuth,
} from '@kilocode/web-shared/lib/ai-gateway/byok-endpoint';
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

/** The request fields `applyTrackingIds` sets; `prompt_cache_key` stays because it only aids caching. */
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

async function resolveAuth(
  providerId: ByokEndpointProviderId,
  credential: string
): Promise<Pick<DirectByokUpstream, 'apiKey' | 'apiKeyHeader' | 'awsBedrock'>> {
  const credentials = parseByokEndpointCredentials(credential);
  if (!credentials) throw new InvalidByokEndpointCredentialsError(providerId);
  const auth = await resolveByokEndpointAuth(credentials);
  switch (auth.type) {
    case 'api_key':
      return { apiKey: auth.apiKey, apiKeyHeader: auth.apiKeyHeader };
    case 'aws_bedrock':
      return { apiKey: '', apiKeyHeader: null, awsBedrock: auth.credentials };
    case 'secure_proxy':
      throw new InvalidByokEndpointCredentialsError(providerId);
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
        ...(await resolveAuth(providerId, credential)),
        supportedChatApis: getByokEndpointModelApiKinds(definition, served),
        responseTransforms: getByokEndpointModelResponseTransform(definition, served),
      };
    },
    transformRequest({ request, extraHeaders }) {
      // An organization's upstream has no use for the user and session ids Kilo adds.
      removeTrackingIds(request.body as Record<string, unknown>);
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
