import type { FeatureValue } from '@/lib/feature-detection';
import type { ProviderId } from '@/lib/ai-gateway/providers/types';
import type { FraudDetectionHeaders } from '@/lib/utils';
import type { GatewayApiKind, MicrodollarUsage, Organization } from '@kilocode/db';
import type { OpenAI } from 'openai';

export type OpenRouterUsage = {
  cost?: number;
  is_byok?: boolean | null;
  cost_details?: { upstream_inference_cost: number };
  completion_tokens: number;
  completion_tokens_details: { reasoning_tokens: number };
  prompt_tokens: number;
  prompt_tokens_details: {
    cached_tokens: number;
    cache_write_tokens?: number; // OpenRouter
    cache_creation_input_tokens?: number; // Alibaba
  };
  total_tokens: number;
}; //ref: https://openrouter.ai/docs/use-cases/usage-accounting#response-format

export type VercelProviderMetaData = {
  gateway?: { routing?: { finalProvider?: string }; cost?: string; marketCost?: string };
};

export type MaybeHasVercelProviderMetaData = {
  choices?: {
    message?: {
      provider_metadata?: VercelProviderMetaData;
    };
  }[];
};

export type MaybeHasVercelProviderMetaDataChunk = {
  choices?: {
    delta?: { provider_metadata?: VercelProviderMetaData };
  }[];
};

export type MaybeHasOpenRouterUsage = {
  usage?: OpenRouterUsage | null;
  provider?: string | null;
};

export type ChatCompletionChunk = OpenAI.Chat.Completions.ChatCompletionChunk &
  MaybeHasOpenRouterUsage &
  MaybeHasVercelProviderMetaDataChunk;

export interface Message {
  role: string;
  content?: string | ({ type?: string; text?: string } | null)[];
  parts?: { text?: string }[];
}

export type NotYetCostedUsageStats = {
  messageId: string | null;
  model: string | null;
  responseContent: string;
  hasError: boolean;
  inference_provider: string | null;
  upstream_id: string | null;
  finish_reason: string | null;
  latency: number | null;
  moderation_latency: number | null;
  generation_time: number | null;
  streamed: boolean | null;
  cancelled: boolean | null;
};

export type JustTheCostsUsageStats = {
  cost_mUsd: number;
  cacheDiscount_mUsd?: number;
  /** The real cost before any free/BYOK/promo zeroing. Set by processTokenData. */
  market_cost?: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheHitTokens: number;
  is_byok: boolean | null;
};

export type MicrodollarUsageStats = NotYetCostedUsageStats & JustTheCostsUsageStats;

export type PromptInfo = {
  system_prompt_prefix: string;
  system_prompt_length: number;
  user_prompt_prefix: string;
};

export type MicrodollarUsageContext = {
  api_kind: GatewayApiKind;
  kiloUserId: string;
  fraudHeaders: FraudDetectionHeaders;
  organizationId?: Organization['id'];
  provider: ProviderId;
  requested_model: string;
  promptInfo: PromptInfo;
  max_tokens: number | null;
  has_middle_out_transform: boolean | null;
  isStreaming: boolean;
  prior_microdollar_usage: number;
  /** User email for authenticated users - used as PostHog distinctId. Undefined for anonymous users. */
  posthog_distinct_id?: string;
  project_id: string | null;
  status_code: number | null;
  editor_name: string | null;
  machine_id: string | null;
  /** True if user/org is using their own API key - cost should be zeroed out */
  user_byok: boolean;
  has_tools: boolean;
  botId?: string;
  tokenSource?: string;
  /** Request ID from abuse service classify response, for cost tracking correlation. 0 means skip. */
  abuse_request_id?: number;
  /** Which product feature generated this API call. NULL if header not sent. */
  feature: FeatureValue | null;
  /** Client session/task identifier from X-KiloCode-TaskId header. */
  session_id: string | null;
  /** Client mode from x-kilocode-mode header (e.g. 'code', 'build', 'architect'). */
  mode: string | null;
  /** The auto model ID when one was requested (e.g. 'kilo-auto/free'). */
  auto_model: string | null;
  /** Time to first byte from the upstream provider, in milliseconds. Set after the upstream request returns. */
  ttfb_ms: number | null;
};

export type CoreUsageWithMetaData = {
  core: MicrodollarUsage;
  metadata: UsageMetaData;
};

export type BalanceUpdateResult = { newMicrodollarsUsed: number } | null;

export type UsageMetaData = {
  id: string;
  message_id: string;
  created_at: string;
  http_x_forwarded_for: string | null;
  http_x_vercel_ip_city: string | null;
  http_x_vercel_ip_country: string | null;
  http_x_vercel_ip_latitude: number | null;
  http_x_vercel_ip_longitude: number | null;
  http_x_vercel_ja4_digest: string | null;
  user_prompt_prefix: string | null;
  system_prompt_prefix: string | null;
  system_prompt_length: number | null;
  http_user_agent: string | null;
  max_tokens: number | null;
  has_middle_out_transform: boolean | null;
  status_code: number | null;
  upstream_id: string | null;
  finish_reason: string | null;
  latency: number | null;
  moderation_latency: number | null;
  generation_time: number | null;
  is_byok: boolean | null;
  is_user_byok: boolean;
  streamed: boolean | null;
  cancelled: boolean | null;
  editor_name: string | null;
  api_kind: GatewayApiKind | null;
  has_tools: boolean | null;
  machine_id: string | null;
  feature: string | null;
  session_id: string | null;
  mode: string | null;
  auto_model: string | null;
  market_cost: number | null;
  is_free: boolean | null;
};

export type OpenRouterError = {
  message: string;
  code: string;
  metadata?: Record<string, unknown>;
  provider_name?: string;
};
