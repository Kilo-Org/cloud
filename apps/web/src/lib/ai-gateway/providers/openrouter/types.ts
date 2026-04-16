import type OpenAI from 'openai';
import type { GatewayProviderOptions } from '@ai-sdk/gateway';
import type { AnthropicProviderOptions } from '@ai-sdk/anthropic';
import type { ReasoningDetailUnion } from '@/lib/ai-gateway/custom-llm/reasoning-details';
import type { AwsCredentials } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type Anthropic from '@anthropic-ai/sdk';

// Base types for OpenRouter API that don't depend on other lib files
// This breaks circular dependencies with mistral.ts, minimax.ts, etc.

export type OpenRouterProviderConfig = {
  order?: string[];
  only?: string[];
  ignore?: string[];
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

// OpenCode sometimes adds these non-standard properties
export type OpenCodeSpecificProperties = {
  description?: string;
  usage?: { include?: boolean };
  reasoningEffort?: string;
};

export type SharedGatewayRequestProperties = {
  // https://openrouter.ai/docs/features/provider-routing#requiring-providers-to-comply-with-data-policies
  provider?: OpenRouterProviderConfig;
  providerOptions?: VercelProviderConfig;

  // OpenRouter specific field we do not support
  // https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request#request.body.models
  models?: string[];

  // Non-standard reasoning configuration
  enable_thinking?: boolean; // Alibaba
  thinking?: { type?: 'enabled' | 'adaptive' | 'disabled' }; // ByteDance, Z.ai
};

export type GatewayResponsesRequest = SharedGatewayRequestProperties &
  OpenAI.Responses.ResponseCreateParams;

export type GatewayMessagesRequest = SharedGatewayRequestProperties &
  Anthropic.MessageCreateParams & {
    user?: string;
    session_id?: string;
  };

/**
 * Approximately OpenRouter API request type. Actually based on OpenAI's, but the differences aren't huge.
 */
export type OpenRouterChatCompletionRequest = OpenAI.Chat.ChatCompletionCreateParams &
  SharedGatewayRequestProperties & {
    max_tokens?: number;
    transforms?: string[];

    // https://openrouter.ai/docs/use-cases/reasoning-tokens#controlling-reasoning-tokens
    reasoning?: OpenRouterReasoningConfig;

    // https://platform.minimax.io/docs/api-reference/text-openai-api#4-important-note
    reasoning_split?: boolean;
  };

export type MessageWithReasoning = {
  reasoning?: string;
  reasoning_content?: string;
  reasoning_details?: ReasoningDetailUnion[];
};

export type GatewayRequest =
  | { kind: 'chat_completions'; body: OpenRouterChatCompletionRequest }
  | { kind: 'responses'; body: GatewayResponsesRequest }
  | { kind: 'messages'; body: GatewayMessagesRequest };

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
    native_tokens_cached?: number | null; //missing from docs
    native_tokens_cache_creation?: number | null; //vercel specific
    num_media_prompt?: number | null;
    num_media_completion?: number | null;
    num_search_results?: number | null;
  };
};
