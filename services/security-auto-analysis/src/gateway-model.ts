import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { CustomLlmProviderSchema, type CustomLlmProvider } from '@kilocode/db/schema-types';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { logger } from './logger.js';

export type GatewayConnection = {
  backendBaseUrl: string;
  authToken: string;
  headers: Record<string, string>;
  abortSignal?: AbortSignal;
};

const ModelCatalogSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      opencode: z
        .object({ ai_sdk_provider: CustomLlmProviderSchema.optional().catch(undefined) })
        .nullish()
        .catch(undefined),
    })
  ),
});

function gatewayBaseUrl(backendBaseUrl: string): string {
  return `${backendBaseUrl.replace(/\/$/, '')}/api/openrouter`;
}

/**
 * Picks the AI SDK provider the Kilo CLI would use for this model: the
 * `opencode.ai_sdk_provider` advertised by the gateway model catalog for the
 * same user and organization, falling back to OpenRouter.
 */
export async function resolveAiSdkProvider(
  model: string,
  connection: GatewayConnection
): Promise<CustomLlmProvider> {
  try {
    const response = await fetch(`${gatewayBaseUrl(connection.backendBaseUrl)}/models`, {
      headers: { ...connection.headers, Authorization: `Bearer ${connection.authToken}` },
      signal: connection.abortSignal,
    });
    if (!response.ok) {
      throw new Error(`Model catalog request failed with status ${response.status}`);
    }
    const catalog = ModelCatalogSchema.parse(await response.json());
    return (
      catalog.data.find(entry => entry.id === model)?.opencode?.ai_sdk_provider ?? 'openrouter'
    );
  } catch (error) {
    logger.warn('Falling back to the OpenRouter AI SDK provider', {
      model,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'openrouter';
  }
}

export function createGatewayLanguageModel(
  provider: CustomLlmProvider,
  model: string,
  connection: GatewayConnection
): LanguageModel {
  const options = {
    baseURL: gatewayBaseUrl(connection.backendBaseUrl),
    headers: connection.headers,
  };
  switch (provider) {
    case 'anthropic':
      return createAnthropic({ ...options, authToken: connection.authToken })(model);
    case 'openai':
      return createOpenAI({ ...options, apiKey: connection.authToken }).responses(model);
    case 'openai-compatible':
      return createOpenAICompatible({
        ...options,
        name: 'kilo-gateway',
        apiKey: connection.authToken,
      }).chatModel(model);
    case 'openrouter':
      return createOpenRouter({ ...options, apiKey: connection.authToken }).chat(model);
  }
}
