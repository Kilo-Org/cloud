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
import type { GatewayChatApiKind } from '@kilocode/web-shared/lib/ai-gateway/providers/types';

/**
 * Bedrock serves its catalog from two hosts. `bedrock-runtime` speaks Chat
 * Completions for most open-weight models and Anthropic Messages for Claude
 * (through cross-region inference profiles). `bedrock-mantle` speaks the
 * Responses API for the models models.dev routes there, on two base paths that
 * each accept only their own models.
 */
export const AWS_BEDROCK_ENDPOINTS = {
  'runtime-openai': {
    api: 'chat_completions',
    url: region => `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`,
  },
  'runtime-anthropic': {
    api: 'messages',
    url: region => `https://bedrock-runtime.${region}.amazonaws.com/anthropic/v1`,
  },
  'mantle-v1': {
    api: 'responses',
    url: region => `https://bedrock-mantle.${region}.api.aws/v1`,
  },
  'mantle-openai': {
    api: 'responses',
    url: region => `https://bedrock-mantle.${region}.api.aws/openai/v1`,
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
  const { api, url } = AWS_BEDROCK_ENDPOINTS[getAwsBedrockEndpoint(model)];
  const upstream = {
    apiUrl: url(credentials.region),
    apiUrlOverrides: {},
    disableUrlSuffix: false,
    supportedChatApis: [api],
    responseTransforms: null,
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
  base_url: AWS_BEDROCK_ENDPOINTS['runtime-openai'].url('us-east-1'),
  base_url_overrides: {},
  supported_chat_apis: ['chat_completions', 'messages', 'responses'],
  reasoning_details_transform: null,
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
