import type {
  ByokPrivateProviderCredentials,
  ByokPrivateProviderDefinition,
  ByokPrivateModel,
  ByokPrivateProviderId,
} from '@kilocode/db/schema-types';
import {
  getByokPrivateModelApiKinds,
  getByokPrivateModelClientApiKind,
  getByokPrivateModelResponseTransform,
  getByokPrivateModelSendsPromptCacheKey,
  parseByokPrivateProviderCredentials,
} from '@kilocode/web-shared/lib/ai-gateway/byok-private-provider';
import { getGoogleServiceAccountAccessToken } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/google-service-account';
import {
  credentialHeaders,
  type DirectByokModel,
  type DirectByokProvider,
  type DirectByokUpstream,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import { getFallbackReasoningOptions } from '@kilocode/web-shared/lib/ai-gateway/providers/reasoning-options';

const ANTHROPIC_VERSION = '2023-06-01';

/** The stored private provider credentials do not parse, so no request can authenticate. */
export class InvalidByokPrivateProviderCredentialsError extends Error {
  constructor(providerId: ByokPrivateProviderId) {
    super(`Private provider ${providerId} has invalid credentials`);
    this.name = 'InvalidByokPrivateProviderCredentialsError';
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
  providerId: ByokPrivateProviderId,
  credential: string
): ByokPrivateProviderCredentials {
  const credentials = parseByokPrivateProviderCredentials(credential);
  if (!credentials) throw new InvalidByokPrivateProviderCredentialsError(providerId);
  return credentials;
}

/** A listed model of the private provider: its id is the one clients use after the provider id. */
function toDirectByokModel(model: ByokPrivateModel): DirectByokModel {
  return {
    id: model.id,
    name: model.name ?? model.id,
    flags: model.flags,
    context_length: model.context_length,
    max_completion_tokens: model.max_completion_tokens,
    // In catalog mode the private provider serves each model under the catalog id it is named after.
    catalog_model_id: model.id,
    reasoning_options: model.flags?.includes('reasoning')
      ? (getFallbackReasoningOptions(model.id) ?? getFallbackReasoningOptions(model.internal_id))
      : undefined,
  };
}

/** The upstream authentication for private provider credentials. */
export async function resolveByokPrivateProviderUpstreamAuth(
  credentials: ByokPrivateProviderCredentials
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
  providerId: ByokPrivateProviderId,
  definition: ByokPrivateProviderDefinition
): DirectByokProvider {
  const privateModels = new Map(definition.models.map(model => [model.id, model]));
  const models = definition.models.map(toDirectByokModel);
  const privateModel = ({ id }: Pick<DirectByokModel, 'id'>) => {
    const model = privateModels.get(id);
    if (!model) throw new Error(`Private provider ${providerId} has no model ${id}`);
    return model;
  };
  return {
    id: providerId,
    private_provider: { name: definition.name },
    models: async () => models,
    upstreamModelId: model => privateModel(model).internal_id,
    getModelChatApi: model => getByokPrivateModelClientApiKind(definition, privateModel(model)),
    getModelChatApis: model => getByokPrivateModelApiKinds(definition, privateModel(model)),
    chatCompletionsHeaders: credentialHeaders,
    async resolveUpstream({ credential, model }) {
      const served = privateModel(model);
      return {
        apiUrl: definition.base_url,
        apiUrlOverrides: {},
        disableUrlSuffix: false,
        ...(await resolveByokPrivateProviderUpstreamAuth(parseCredentials(providerId, credential))),
        supportedChatApis: getByokPrivateModelApiKinds(definition, served),
        responseTransforms: getByokPrivateModelResponseTransform(definition, served),
      };
    },
    transformRequest({ request, extraHeaders }, model) {
      const body = request.body as Record<string, unknown>;
      // An organization's upstream has no use for the user and session ids Kilo adds.
      removeTrackingIds(body);
      if (!getByokPrivateModelSendsPromptCacheKey(definition, privateModel(model))) {
        delete body.prompt_cache_key;
      }
      // Anthropic's own API rejects Messages requests without it; compatible upstreams ignore it.
      if (request.kind === 'messages') extraHeaders['anthropic-version'] ??= ANTHROPIC_VERSION;
    },
  };
}

const providersByDefinition = new WeakMap<ByokPrivateProviderDefinition, DirectByokProvider>();

/**
 * The direct BYOK provider of an organization's private provider key. Its models keep their listed ids,
 * and requests reach the upstream under each model's `internal_id`. It is built once per loaded
 * definition, so catalog lookups that cache per model list keep working.
 */
export function createByokPrivateProviderDirectProvider(
  providerId: ByokPrivateProviderId,
  definition: ByokPrivateProviderDefinition
): DirectByokProvider {
  let provider = providersByDefinition.get(definition);
  if (!provider) {
    provider = createProvider(providerId, definition);
    providersByDefinition.set(definition, provider);
  }
  return provider;
}
