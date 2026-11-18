import type * as z from 'zod';
import { DirectByokModelEndpointSchema } from '@kilocode/db/schema-types';
import { isClaudeModel } from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic/claude-model';
import { isGeminiModel } from '@kilocode/web-shared/lib/ai-gateway/providers/google';
import { dropThinkingBlocksOnPrefixMismatch } from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic/thinking-block-binding';
import { cachedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';
import { DirectVertexCredentialsSchema } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type {
  DirectByokModel,
  DirectByokProvider,
  DirectByokUpstream,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import { credentialHeaders } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import {
  ReasoningDetailsTransform,
  type GatewayChatApiKind,
} from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { getGoogleServiceAccountAccessToken } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/google-service-account';
import { toMistralChatCompletionsBody } from '@kilocode/web-shared/lib/ai-gateway/providers/mistral';

/**
 * Vertex AI serves Gemini and the managed open and partner models through its
 * OpenAI-compatible Chat Completions endpoint, Grok's reasoning models through
 * the Responses API on the same base URL, and Claude and Mistral through their
 * own Messages and Chat Completions formats on per-model `rawPredict` URLs.
 */
export const GcpVertexEndpointSchema = DirectByokModelEndpointSchema.extract([
  'openapi',
  'openapi-responses',
  'anthropic',
  'mistral',
]);

export type GcpVertexEndpoint = z.infer<typeof GcpVertexEndpointSchema>;

export const GCP_VERTEX_ENDPOINTS = {
  openapi: 'chat_completions',
  'openapi-responses': 'responses',
  anthropic: 'messages',
  mistral: 'chat_completions',
} as const satisfies Record<GcpVertexEndpoint, GatewayChatApiKind>;

const DEFAULT_LOCATION = 'global';
const LOCATION_PATTERN = /^[a-z0-9-]+$/;
const PROJECT_PATTERN = /^[a-z0-9.:-]+$/;
const MODEL_ID_PATTERN = /^[a-z0-9._@-]+$/;
const VERTEX_ANTHROPIC_VERSION = 'vertex-2023-10-16';
// Mistral models are only served in these regions, not `global`.
const MISTRAL_US_LOCATION = 'us-central1';
const MISTRAL_EU_LOCATION = 'europe-west4';
export type GcpVertexCredentials = {
  project: string;
  location: string;
  clientEmail: string;
  privateKey: string;
};

function isGcpVertexEndpoint(endpoint: string): endpoint is GcpVertexEndpoint {
  return GcpVertexEndpointSchema.safeParse(endpoint).success;
}

function isGcpVertexMistralModelId(modelId: string) {
  return modelId.startsWith('mistral-') || modelId.startsWith('codestral-');
}

export function getGcpVertexEndpoint(model: Pick<DirectByokModel, 'id' | 'endpoint'>) {
  if (model.endpoint && isGcpVertexEndpoint(model.endpoint)) return model.endpoint;
  if (isClaudeModel(model.id)) return 'anthropic';
  return isGcpVertexMistralModelId(model.id) ? 'mistral' : 'openapi';
}

/** The Mistral region closest to the configured location. */
export function getGcpVertexMistralLocation(location: string) {
  if (location === MISTRAL_US_LOCATION || location === MISTRAL_EU_LOCATION) return location;
  return location === 'eu' || location.startsWith('europe-')
    ? MISTRAL_EU_LOCATION
    : MISTRAL_US_LOCATION;
}

export function parseGcpVertexCredentials(credential: string): GcpVertexCredentials {
  const parsed = DirectVertexCredentialsSchema.parse(JSON.parse(credential));
  const credentials =
    'googleCredentials' in parsed
      ? {
          project: parsed.project,
          location: parsed.location,
          clientEmail: parsed.googleCredentials.clientEmail,
          privateKey: parsed.googleCredentials.privateKey,
        }
      : {
          project: parsed.project_id,
          location: parsed.location ?? DEFAULT_LOCATION,
          clientEmail: parsed.client_email,
          privateKey: parsed.private_key,
        };
  if (!PROJECT_PATTERN.test(credentials.project)) throw new Error('Invalid Google Cloud project');
  if (!LOCATION_PATTERN.test(credentials.location)) throw new Error('Invalid Vertex AI location');
  return credentials;
}

export function getGcpVertexHost(location: string) {
  if (location === 'global') return 'aiplatform.googleapis.com';
  if (location === 'us' || location === 'eu') return `aiplatform.${location}.rep.googleapis.com`;
  return `${location}-aiplatform.googleapis.com`;
}

export function getGcpVertexBaseUrl({ project, location }: GcpVertexCredentials) {
  return `https://${getGcpVertexHost(location)}/v1/projects/${project}/locations/${location}`;
}

/** Gemini models are listed without a publisher; the OpenAI-compatible endpoint needs one. */
export function toGcpVertexOpenApiModelId(modelId: string) {
  return modelId.includes('/') ? modelId : `google/${modelId}`;
}

export function buildGcpVertexUpstream(
  credentials: GcpVertexCredentials,
  accessToken: string,
  model: Pick<DirectByokModel, 'id' | 'endpoint'>,
  stream: boolean
): DirectByokUpstream {
  const endpoint = getGcpVertexEndpoint(model);
  const auth = {
    apiKey: accessToken,
    apiKeyHeader: null,
    apiUrlOverrides: {},
    supportedChatApis: [GCP_VERTEX_ENDPOINTS[endpoint]],
  } as const;
  const baseUrl = getGcpVertexBaseUrl(credentials);
  if (endpoint === 'anthropic') {
    if (!MODEL_ID_PATTERN.test(model.id)) throw new Error('Invalid Vertex AI model id');
    return {
      ...auth,
      apiUrl: `${baseUrl}/publishers/anthropic/models/${model.id}:${stream ? 'streamRawPredict' : 'rawPredict'}`,
      disableUrlSuffix: true,
      responseTransforms: null,
    };
  }
  if (endpoint === 'mistral') {
    if (!MODEL_ID_PATTERN.test(model.id)) throw new Error('Invalid Vertex AI model id');
    const location = getGcpVertexMistralLocation(credentials.location);
    const mistralBaseUrl = getGcpVertexBaseUrl({ ...credentials, location });
    return {
      ...auth,
      apiUrl: `${mistralBaseUrl}/publishers/mistralai/models/${model.id}:${stream ? 'streamRawPredict' : 'rawPredict'}`,
      disableUrlSuffix: true,
      responseTransforms: null,
    };
  }
  if (endpoint === 'openapi-responses') {
    return {
      ...auth,
      apiUrl: `${baseUrl}/endpoints/openapi`,
      disableUrlSuffix: false,
      responseTransforms: null,
    };
  }
  return {
    ...auth,
    apiUrl: `${baseUrl}/endpoints/openapi`,
    disableUrlSuffix: false,
    // Gemini returns thoughts in Google's extra content; the managed open models in `reasoning_content`.
    responseTransforms: isGeminiModel(model.id)
      ? ReasoningDetailsTransform.GeminiThought
      : ReasoningDetailsTransform.ReasoningContent,
  };
}

export async function resolveGcpVertexUpstream(
  credential: string,
  model: Pick<DirectByokModel, 'id' | 'endpoint'>,
  stream: boolean
): Promise<DirectByokUpstream> {
  const credentials = parseGcpVertexCredentials(credential);
  const accessToken = await getGoogleServiceAccountAccessToken({
    client_email: credentials.clientEmail,
    private_key: credentials.privateKey,
  });
  return buildGcpVertexUpstream(credentials, accessToken, model, stream);
}

export default {
  id: 'vertex-byok',
  openrouter_inference_provider_id: 'google-vertex',
  models_dev_id: 'google-vertex',
  transformRequest(context) {
    const { request } = context;
    if (request.kind === 'messages') {
      dropThinkingBlocksOnPrefixMismatch(context);
      // rawPredict takes the model from the URL and the API version from the body.
      Reflect.deleteProperty(request.body, 'model');
      Reflect.set(request.body, 'anthropic_version', VERTEX_ANTHROPIC_VERSION);
      return;
    }
    if (request.kind === 'chat_completions') {
      if (isGcpVertexMistralModelId(request.body.model)) {
        // rawPredict takes the model from the URL but still requires it in the body.
        toMistralChatCompletionsBody(request.body);
        return;
      }
      request.body.model = toGcpVertexOpenApiModelId(request.body.model);
    }
  },
  models: cachedDirectByokModelList('vertex-byok'),
  chatCompletionsHeaders: credentialHeaders,
  async resolveUpstream({ credential, model, stream }) {
    return resolveGcpVertexUpstream(credential, model, stream);
  },
  getModelChatApi(model) {
    return GCP_VERTEX_ENDPOINTS[getGcpVertexEndpoint(model)];
  },
} satisfies DirectByokProvider;
