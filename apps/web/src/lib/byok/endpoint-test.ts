import { parseByokEndpointCredentials } from '@kilocode/web-shared/lib/ai-gateway/byok-endpoint';
import {
  createDirectByokGatewayProvider,
  formatDirectByokModelId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import type { DirectByokProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type { GatewayChatApiKind } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { CHAT_API_PATHS } from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-request';
import { applyTrackingIds } from '@kilocode/web-shared/lib/ai-gateway/providerHash';
import { EmptyFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import {
  ByokEndpointRequestError,
  describeByokEndpointError,
  fetchByokEndpoint,
} from '@/lib/byok/endpoint-upstream';

const TEST_PROMPT = 'Say hi';
const TEST_MAX_TOKENS = 256;
/** Stands in for the task id clients send, so the request carries what a client's request would. */
const TEST_TASK_ID = 'byok-endpoint-test';

function testRequest(
  apiKind: GatewayChatApiKind,
  model: string,
  maxTokensField: 'max_tokens' | 'max_completion_tokens'
): GatewayRequest {
  const messages = [{ role: 'user' as const, content: TEST_PROMPT }];
  switch (apiKind) {
    case 'chat_completions':
      return { kind: apiKind, body: { model, messages, [maxTokensField]: TEST_MAX_TOKENS } };
    case 'messages':
      return { kind: apiKind, body: { model, messages, max_tokens: TEST_MAX_TOKENS } };
    case 'responses':
      return {
        kind: apiKind,
        body: { model, input: TEST_PROMPT, max_output_tokens: TEST_MAX_TOKENS },
      };
  }
}

export type ByokEndpointTestResult = { success: boolean; message: string };

/**
 * Sends a tiny prompt to one model of the endpoint over the API clients use for it, transformed
 * as the gateway transforms a client's request, so the test sends what real requests send. Any
 * 2xx answer counts as success: a reasoning model may spend the small token budget before
 * replying.
 */
export async function testByokEndpoint({
  provider,
  credential,
  modelId,
  userId,
  organizationId,
}: {
  /** The endpoint, as `directByokProviderForKey` builds it. */
  provider: DirectByokProvider;
  /** The stored credentials JSON `provider` resolves its upstream from. */
  credential: string;
  modelId?: string;
  userId: string;
  organizationId: string;
}): Promise<ByokEndpointTestResult> {
  const models = await provider.models();
  const model = modelId ? models.find(candidate => candidate.id === modelId) : models[0];
  const name = provider.organization_endpoint?.name ?? provider.id;
  if (!model) return { success: false, message: `Endpoint ${name} has no model ${modelId}.` };
  const credentials = parseByokEndpointCredentials(credential);
  if (!credentials) {
    return {
      success: false,
      message: 'API key test failed: the stored endpoint configuration is invalid.',
    };
  }

  // An endpoint names the API clients use for each model; Chat Completions is the default.
  const apiKind = provider.getModelChatApi?.(model) ?? 'chat_completions';
  const upstream = await provider.resolveUpstream({ credential, model, stream: false });
  const gatewayProvider = createDirectByokGatewayProvider(provider, model, upstream);
  const apiUrl = upstream.apiUrlOverrides[apiKind] ?? upstream.apiUrl;
  const url = upstream.disableUrlSuffix ? apiUrl : apiUrl + CHAT_API_PATHS[apiKind];

  const send = async (maxTokensField: 'max_tokens' | 'max_completion_tokens') => {
    const request = testRequest(apiKind, formatDirectByokModelId(provider, model), maxTokensField);
    applyTrackingIds(request, gatewayProvider, userId, TEST_TASK_ID);
    const extraHeaders: Record<string, string> = {};
    await gatewayProvider.transformRequest({
      provider: gatewayProvider,
      model: formatDirectByokModelId(provider, model),
      request,
      originalHeaders: EmptyFraudDetectionHeaders,
      extraHeaders,
      userByok: [{ decryptedAPIKey: credential, providerId: provider.id }],
      kilo_user_id: userId,
      organization_id: organizationId,
      session_id: null,
    });
    return fetchByokEndpoint({
      url,
      method: 'POST',
      body: JSON.stringify(request.body),
      credentials,
      headers: extraHeaders,
    });
  };

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
      message: `API key test success. Endpoint: ${name}. Model: ${model.id}.`,
    };
  } catch (error) {
    if (error instanceof ByokEndpointRequestError) {
      return { success: false, message: `API key test failed: ${error.message}` };
    }
    throw error;
  }
}
