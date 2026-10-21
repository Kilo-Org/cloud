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
 * OpenAI-compatible Chat Completions endpoint, and Claude through Anthropic's
 * Messages format on per-model `rawPredict` URLs.
 */
export const GCP_VERTEX_ENDPOINTS = {
  openapi: 'chat_completions',
  anthropic: 'messages',
} as const satisfies Record<string, GatewayChatApiKind>;

export type GcpVertexEndpoint = keyof typeof GCP_VERTEX_ENDPOINTS;

const DEFAULT_LOCATION = 'global';
const LOCATION_PATTERN = /^[a-z0-9-]+$/;
const PROJECT_PATTERN = /^[a-z0-9.:-]+$/;
const MODEL_ID_PATTERN = /^[a-z0-9._@-]+$/;
const VERTEX_ANTHROPIC_VERSION = 'vertex-2023-10-16';

export type GcpVertexCredentials = {
  project: string;
  location: string;
  clientEmail: string;
  privateKey: string;
};

function isGcpVertexEndpoint(endpoint: string): endpoint is GcpVertexEndpoint {
  return Object.hasOwn(GCP_VERTEX_ENDPOINTS, endpoint);
}

export function getGcpVertexEndpoint(model: Pick<DirectByokModel, 'id' | 'endpoint'>) {
  if (model.endpoint && isGcpVertexEndpoint(model.endpoint)) return model.endpoint;
  return model.id.startsWith('claude-') ? 'anthropic' : 'openapi';
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
  const auth = { apiKey: accessToken, apiKeyHeader: null, apiUrlOverrides: {} } as const;
  const baseUrl = getGcpVertexBaseUrl(credentials);
  if (endpoint === 'anthropic') {
    if (!MODEL_ID_PATTERN.test(model.id)) throw new Error('Invalid Vertex AI model id');
    return {
      ...auth,
      apiUrl: `${baseUrl}/publishers/anthropic/models/${model.id}:${stream ? 'streamRawPredict' : 'rawPredict'}`,
      disableUrlSuffix: true,
      supportedChatApis: ['messages'],
      responseTransforms: null,
    };
  }
  return {
    ...auth,
    apiUrl: `${baseUrl}/endpoints/openapi`,
    disableUrlSuffix: false,
    supportedChatApis: ['chat_completions'],
    // Gemini returns thoughts in Google's extra content; the managed open models in `reasoning_content`.
    responseTransforms: model.id.includes('gemini')
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
  id: 'gcp-vertex',
  base_url: 'https://aiplatform.googleapis.com/v1',
  base_url_overrides: {},
  supported_chat_apis: ['chat_completions', 'messages'],
  reasoning_details_transform: null,
  transformRequest(context) {
    const { request } = context;
    if (request.kind === 'messages') {
      // rawPredict takes the model from the URL and the API version from the body.
      Reflect.deleteProperty(request.body, 'model');
      Reflect.set(request.body, 'anthropic_version', VERTEX_ANTHROPIC_VERSION);
      return;
    }
    if (request.kind === 'chat_completions') {
      request.body.model = toGcpVertexOpenApiModelId(request.body.model);
    }
  },
  models: cachedEnhancedDirectByokModelList({ providerId: 'gcp-vertex', recommendedModels: [] }),
  async resolveUpstream({ credential, model, stream }) {
    return resolveGcpVertexUpstream(credential, model, stream);
  },
  getModelChatApi(model) {
    return GCP_VERTEX_ENDPOINTS[getGcpVertexEndpoint(model)];
  },
} satisfies DirectByokProvider;
