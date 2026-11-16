import type {
  ByokEndpointCredentials,
  ByokEndpointDefinition,
  ByokEndpointModel,
  CustomLlmApiKind,
} from '@kilocode/db/schema-types';
import {
  getByokEndpointModelBaseUrl,
  getByokEndpointModelClientApiKind,
  hasByokEndpointModelPlaceholder,
} from '@kilocode/web-shared/lib/ai-gateway/byok-endpoint';
import {
  ByokEndpointRequestError,
  describeByokEndpointError,
  fetchByokEndpoint,
} from '@/lib/byok/endpoint-upstream';

const TEST_PROMPT = 'Say hi';
const TEST_MAX_TOKENS = 256;

const API_PATHS = {
  chat_completions: '/chat/completions',
  messages: '/messages',
  responses: '/responses',
} as const satisfies Record<CustomLlmApiKind, string>;

function testRequestBody(
  apiKind: CustomLlmApiKind,
  model: string | undefined,
  maxTokensField: 'max_tokens' | 'max_completion_tokens'
): Record<string, unknown> {
  switch (apiKind) {
    case 'chat_completions':
      return {
        model,
        messages: [{ role: 'user', content: TEST_PROMPT }],
        [maxTokensField]: TEST_MAX_TOKENS,
      };
    case 'messages':
      return {
        model,
        max_tokens: TEST_MAX_TOKENS,
        messages: [{ role: 'user', content: TEST_PROMPT }],
      };
    case 'responses':
      return { model, input: TEST_PROMPT, max_output_tokens: TEST_MAX_TOKENS };
  }
}

export type ByokEndpointTestResult = { success: boolean; message: string };

/**
 * Sends a tiny prompt to one model of the endpoint over the API clients use for it. Any 2xx
 * answer counts as success: a reasoning model may spend the small token budget before replying.
 */
export async function testByokEndpoint({
  definition,
  credentials,
  modelId,
}: {
  definition: ByokEndpointDefinition;
  credentials: ByokEndpointCredentials;
  modelId?: string;
}): Promise<ByokEndpointTestResult> {
  const model: ByokEndpointModel | undefined = modelId
    ? definition.models.find(candidate => candidate.id === modelId)
    : definition.models[0];
  if (!model) {
    return { success: false, message: `Endpoint ${definition.name} has no model ${modelId}.` };
  }

  const apiKind = getByokEndpointModelClientApiKind(definition, model);
  const url = getByokEndpointModelBaseUrl(definition, model) + API_PATHS[apiKind];
  const bodyModel = hasByokEndpointModelPlaceholder(definition.base_url)
    ? undefined
    : model.internal_id;
  const send = (maxTokensField: 'max_tokens' | 'max_completion_tokens') =>
    fetchByokEndpoint({
      url,
      method: 'POST',
      body: JSON.stringify(testRequestBody(apiKind, bodyModel, maxTokensField)),
      credentials,
      headers: apiKind === 'messages' ? { 'anthropic-version': '2023-06-01' } : {},
    });

  try {
    let response = await send('max_tokens');
    // OpenAI's newer models reject `max_tokens` on Chat Completions and name its replacement.
    if (
      apiKind === 'chat_completions' &&
      response.status === 400 &&
      response.text.includes('max_completion_tokens')
    ) {
      response = await send('max_completion_tokens');
    }
    if (!response.ok) {
      return {
        success: false,
        message: `API key test failed: ${describeByokEndpointError(response)}`,
      };
    }
    return {
      success: true,
      message: `API key test success. Endpoint: ${definition.name}. Model: ${model.id}.`,
    };
  } catch (error) {
    if (error instanceof ByokEndpointRequestError) {
      return { success: false, message: `API key test failed: ${error.message}` };
    }
    throw error;
  }
}
