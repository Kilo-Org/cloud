import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { getAiSdkProvider } from '@kilocode/worker-utils/ai-sdk-provider';
import { isDirectByokModelId } from '@kilocode/worker-utils/direct-byok-model';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';

export type GatewayConnection = {
  backendBaseUrl: string;
  authToken: string;
  headers: Record<string, string>;
};

/**
 * Builds the model with the AI SDK provider Kilo clients use for this gateway
 * model, so the request reaches the gateway API (Messages, Responses or Chat
 * Completions) that the model's provider route supports.
 */
export function createGatewayLanguageModel(
  model: string,
  connection: GatewayConnection
): LanguageModel {
  const directProviderId = isDirectByokModelId(model) ? (model.split('/')[0] ?? null) : null;
  const options = {
    baseURL: `${connection.backendBaseUrl.replace(/\/$/, '')}/api/openrouter`,
    headers: connection.headers,
  };
  switch (getAiSdkProvider(model, directProviderId)) {
    case 'anthropic':
      return createAnthropic({ ...options, authToken: connection.authToken })(model);
    case 'openai':
      return createOpenAI({ ...options, apiKey: connection.authToken }).responses(model);
    case undefined:
      return createOpenRouter({ ...options, apiKey: connection.authToken }).chat(model);
  }
}
