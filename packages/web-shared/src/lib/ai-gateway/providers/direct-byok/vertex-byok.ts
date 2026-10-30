import type * as z from 'zod';
import { DirectByokModelEndpointSchema } from '@kilocode/db/schema-types';
import { isClaudeModel } from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic.constants';
import { isGeminiModel } from '@kilocode/web-shared/lib/ai-gateway/providers/google';
import { dropThinkingBlocksOnPrefixMismatch } from '@kilocode/web-shared/lib/ai-gateway/providers/thinking-block-binding';
import { cachedEnhancedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';
import { DirectVertexCredentialsSchema } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type {
  DirectByokModel,
  DirectByokProvider,
  DirectByokUpstream,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import {
  ReasoningDetailsTransform,
  type GatewayChatApiKind,
} from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { getGoogleServiceAccountAccessToken } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/google-service-account';

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
// Mistral's API rejects any other request or message field with a 422.
const MISTRAL_REQUEST_FIELDS = new Set([
  'model',
  'messages',
  'temperature',
  'top_p',
  'max_tokens',
  'stream',
  'stream_options',
  'stop',
  'random_seed',
  'response_format',
  'tools',
  'tool_choice',
  'presence_penalty',
  'frequency_penalty',
  'n',
  'parallel_tool_calls',
  'prediction',
  'safe_prompt',
]);
const MISTRAL_MESSAGE_FIELDS = new Set([
  'role',
  'content',
  'name',
  'tool_calls',
  'tool_call_id',
  'prefix',
]);

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deleteFieldsExcept(value: object, allowed: ReadonlySet<string>) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) Reflect.deleteProperty(value, key);
  }
}

/** Reduces an OpenAI-style Chat Completions body to the fields Mistral's API accepts. */
export function toMistralChatCompletionsBody(body: object) {
  const maxCompletionTokens: unknown = Reflect.get(body, 'max_completion_tokens');
  if (Reflect.get(body, 'max_tokens') === undefined && maxCompletionTokens !== undefined) {
    Reflect.set(body, 'max_tokens', maxCompletionTokens);
  }
  const seed: unknown = Reflect.get(body, 'seed');
  if (Reflect.get(body, 'random_seed') === undefined && seed !== undefined) {
    Reflect.set(body, 'random_seed', seed);
  }
  deleteFieldsExcept(body, MISTRAL_REQUEST_FIELDS);

  const messages: unknown = Reflect.get(body, 'messages');
  for (const message of Array.isArray(messages) ? messages : []) {
    if (isRecord(message)) deleteFieldsExcept(message, MISTRAL_MESSAGE_FIELDS);
  }
  const tools: unknown = Reflect.get(body, 'tools');
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (isRecord(tool) && isRecord(tool.function)) delete tool.function.strict;
  }
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
  models: cachedEnhancedDirectByokModelList({ providerId: 'vertex-byok', recommendedModels: [] }),
  async resolveUpstream({ credential, model, stream }) {
    return resolveGcpVertexUpstream(credential, model, stream);
  },
  getModelChatApi(model) {
    return GCP_VERTEX_ENDPOINTS[getGcpVertexEndpoint(model)];
  },
} satisfies DirectByokProvider;
