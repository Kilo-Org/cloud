import type OpenAI from 'openai';
import type { GatewayProviderOptions } from '@ai-sdk/gateway';
import type { AnthropicProviderOptions } from '@ai-sdk/anthropic';
import type { ReasoningDetailUnion } from './reasoning-details.js';
import type { AwsCredentials } from './inference-provider-id.js';

export type OpenRouterProviderConfig = {
  order?: string[];
  only?: string[];
  data_collection?: 'allow' | 'deny';
  zdr?: boolean;
};

export type VercelInferenceProviderConfig = { apiKey: string; baseURL?: string } | AwsCredentials;

export type VercelProviderConfig = {
  gateway?: GatewayProviderOptions & {
    byok?: Record<string, VercelInferenceProviderConfig[]>;
  };
  anthropic?: AnthropicProviderOptions;
};

export function isFreePromptTrainingAllowed(provider: OpenRouterProviderConfig | undefined) {
  return provider?.data_collection !== 'deny' && !provider?.zdr;
}

export type OpenRouterReasoningConfig = {
  effort?: OpenAI.Chat.Completions.ChatCompletionReasoningEffort | 'none';
  max_tokens?: number;
  exclude?: boolean;
  enabled?: boolean;
};

type OpenCodeSpecificRequestProperties = {
  description?: string;
  usage?: { include: boolean };
  reasoningEffort?: string;
};

export type OpenRouterChatCompletionRequest = OpenAI.Chat.ChatCompletionCreateParams &
  OpenCodeSpecificRequestProperties & {
    max_tokens?: number;
    transforms?: string[];
    provider?: OpenRouterProviderConfig;
    providerOptions?: VercelProviderConfig;
    reasoning?: OpenRouterReasoningConfig;
    reasoning_split?: boolean;
    thinking?: { type?: 'enabled' | 'disabled' };
    models?: string[];
  };

export type MessageWithReasoning = {
  reasoning?: string;
  reasoning_content?: string;
  reasoning_details?: ReasoningDetailUnion[];
};

export type OpenRouterGeneration = {
  data: {
    id: string;
    is_byok?: boolean | null;
    total_cost: number;
    upstream_inference_cost?: number | null;
    created_at: string;
    model: string;
    origin: string;
    usage: number;
    upstream_id?: string | null;
    cache_discount?: number | null;
    app_id?: number | null;
    streamed?: boolean | null;
    cancelled?: boolean | null;
    provider_name?: string | null;
    latency?: number | null;
    moderation_latency?: number | null;
    generation_time?: number | null;
    finish_reason?: string | null;
    native_finish_reason?: string | null;
    tokens_prompt?: number | null;
    tokens_completion?: number | null;
    native_tokens_prompt?: number | null;
    native_tokens_completion?: number | null;
    native_tokens_reasoning?: number | null;
    native_tokens_cached?: number | null;
    num_media_prompt?: number | null;
    num_media_completion?: number | null;
    num_search_results?: number | null;
  };
};
