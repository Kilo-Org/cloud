import { cachedEnhancedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';
import {
  BedrockCredentialsSchema,
  type BedrockCredentials,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type {
  DirectByokModel,
  DirectByokProvider,
  DirectByokUpstream,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import {
  ReasoningDetailsTransform,
  type GatewayChatApiKind,
  type ProviderResponseTransforms,
} from '@kilocode/web-shared/lib/ai-gateway/providers/types';

/**
 * Bedrock serves its catalog from two hosts:
 * - `bedrock-mantle` speaks Chat Completions for most open-weight models
 *   (`/v1`), returning their reasoning as a `reasoning` string, and the
 *   Responses API for OpenAI's GPT models and Gemma (`/openai/v1`).
 * - `bedrock-runtime` speaks Anthropic Messages for Claude, and Chat
 *   Completions and the Responses API for models only available through a
 *   cross-region inference profile.
 */
export const AWS_BEDROCK_ENDPOINTS = {
  'mantle-chat': {
    api: 'chat_completions',
    url: region => `https://bedrock-mantle.${region}.api.aws/v1`,
  },
  'mantle-openai': {
    api: 'responses',
    url: region => `https://bedrock-mantle.${region}.api.aws/openai/v1`,
  },
  'runtime-anthropic': {
    api: 'messages',
    url: region => `https://bedrock-runtime.${region}.amazonaws.com/anthropic/v1`,
  },
  'runtime-openai': {
    api: 'chat_completions',
    url: region => `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`,
  },
  'runtime-responses': {
    api: 'responses',
    url: region => `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`,
  },
} as const satisfies Record<string, { api: GatewayChatApiKind; url(region: string): string }>;

export type AwsBedrockEndpoint = keyof typeof AWS_BEDROCK_ENDPOINTS;

const AWS_REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d+$/;
const ANTHROPIC_VERSION = '2023-06-01';

function isAwsBedrockEndpoint(endpoint: string): endpoint is AwsBedrockEndpoint {
  return Object.hasOwn(AWS_BEDROCK_ENDPOINTS, endpoint);
}

export function getAwsBedrockEndpoint(model: Pick<DirectByokModel, 'id' | 'endpoint'>) {
  if (model.endpoint && isAwsBedrockEndpoint(model.endpoint)) return model.endpoint;
  return model.id.includes('anthropic.claude') ? 'runtime-anthropic' : 'runtime-openai';
}

/**
 * Where Chat Completions return reasoning, verified on 2026-10-26: mantle
 * returns a `reasoning` string, and so does runtime except for Moonshot's Kimi,
 * which returns `reasoning_content`.
 */
function getAwsBedrockResponseTransforms(
  endpoint: AwsBedrockEndpoint,
  modelId: string
): ProviderResponseTransforms | null {
  if (AWS_BEDROCK_ENDPOINTS[endpoint].api !== 'chat_completions') return null;
  if (endpoint === 'runtime-openai' && modelId.includes('moonshotai.')) {
    return ReasoningDetailsTransform.ReasoningContent;
  }
  return ReasoningDetailsTransform.Reasoning;
}

export function parseAwsBedrockCredentials(credential: string): BedrockCredentials {
  const credentials = BedrockCredentialsSchema.parse(JSON.parse(credential));
  if (!AWS_REGION_PATTERN.test(credentials.region)) {
    throw new Error('Invalid AWS region');
  }
  return credentials;
}

export function resolveAwsBedrockUpstream(
  credential: string,
  model: Pick<DirectByokModel, 'id' | 'endpoint'>
): DirectByokUpstream {
  const credentials = parseAwsBedrockCredentials(credential);
  const endpoint = getAwsBedrockEndpoint(model);
  const { api, url } = AWS_BEDROCK_ENDPOINTS[endpoint];
  const upstream = {
    apiUrl: url(credentials.region),
    apiUrlOverrides: {},
    disableUrlSuffix: false,
    supportedChatApis: [api],
    responseTransforms: getAwsBedrockResponseTransforms(endpoint, model.id),
  } satisfies Partial<DirectByokUpstream>;

  if (credentials.accessKeyId === undefined) {
    return {
      ...upstream,
      apiKey: credentials.apiKey,
      apiKeyHeader: api === 'messages' ? 'x-api-key' : null,
    };
  }
  return {
    ...upstream,
    apiKey: '',
    apiKeyHeader: null,
    awsBedrock: {
      type: 'aws_bedrock',
      region: credentials.region,
      access_key_id: credentials.accessKeyId,
      secret_access_key: credentials.secretAccessKey,
    },
  };
}

export default {
  id: 'aws-bedrock',
  models_dev_id: 'amazon-bedrock',
  transformRequest(context) {
    if (context.request.kind === 'messages') {
      context.extraHeaders['anthropic-version'] ??= ANTHROPIC_VERSION;
    }
  },
  models: cachedEnhancedDirectByokModelList({ providerId: 'aws-bedrock', recommendedModels: [] }),
  async resolveUpstream({ credential, model }) {
    return resolveAwsBedrockUpstream(credential, model);
  },
  getModelChatApi(model) {
    return AWS_BEDROCK_ENDPOINTS[getAwsBedrockEndpoint(model)].api;
  },
} satisfies DirectByokProvider;
