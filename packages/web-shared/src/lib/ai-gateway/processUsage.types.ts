import type { FeatureValue } from '@kilocode/web-shared/lib/feature-detection';
import type { ProviderType } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import type { FraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import type { MicrodollarUsage, Organization } from '@kilocode/db';
import type { CustomPricingTiers } from '@kilocode/db/schema-types';
import type { GatewayApiKind } from '@kilocode/usage-contracts';
import type { OpenAI } from 'openai';
import type { AiProviderMetadataCapture } from '@kilocode/web-shared/lib/r2/kilo-routing-decision';

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

export type VercelProviderAttempt = {
  provider?: string;
  credentialType?: string;
  success?: boolean;
  /** The upstream provider's own request id, e.g. Fireworks' `chatcmpl-…`. */
  providerRequestId?: string;
  /** The upstream provider's own response id; usually equal to `providerRequestId`. */
  providerResponseId?: string;
};

export type VercelModelAttempt = {
  canonicalSlug?: string;
  success?: boolean;
  providerAttempts?: VercelProviderAttempt[];
};

export type VercelProviderMetaData = {
  gateway?: {
    routing?: {
      canonicalSlug?: string;
      finalProvider?: string;
      modelAttempts?: VercelModelAttempt[];
    };
    cost?: string;
    marketCost?: string;
  };
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
  /** Unvalidated upstream value; `toInsertableDbUsageRecord` records a non-string as null. */
  finish_reason: unknown;
  latency: number | null;
  moderation_latency: number | null;
  generation_time: number | null;
  streamed: boolean | null;
  cancelled: boolean | null;
  /** Effective HTTP status code for this usage record. Starts from the upstream
   *  response status and is overwritten by a numeric `error.code` encountered
   *  in-stream (e.g. a 200 response that ends up carrying a 502 error event). */
  status_code: number;
};

export type JustTheCostsUsageStats = {
  cost_mUsd: number;
  cacheDiscount_mUsd?: number;
  /**
   * The real cost before any free/BYOK/promo zeroing. Set by processTokenData.
   * In microdollars, the same unit as `cost_mUsd`; the row stores it in `market_cost`.
   */
  market_cost?: number;
  /**
   * The part of `cost_mUsd` the gateway charged on top of BYOK inference, such as
   * server tools, plugins and PDF parsing. Absent when not reported separately.
   * The row stores it in `non_inference_cost`.
   */
  nonInferenceCost_mUsd?: number;
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

/**
 * The fields a usage context and the persisted `microdollar_usage_metadata` row
 * carry with the same name and type. Both shapes extend this alias, so a change
 * cannot land in one shape only.
 */
export type SharedUsageRecordFields = {
  max_tokens: number | null;
  has_middle_out_transform: boolean | null;
  status_code: number | null;
  editor_name: string | null;
  machine_id: string | null;
  /** Client session/task identifier from X-KiloCode-TaskId header. */
  session_id: string | null;
  /** Client mode from x-kilocode-mode header (e.g. 'code', 'build', 'architect'). */
  mode: string | null;
  /** The auto model ID when one was requested (e.g. 'kilo-auto/free'). */
  auto_model: string | null;
  /** Bounded labels for the reasoning configuration requested by the client. */
  reasoning_setting: string | null;
  /** The Vercel AI Gateway inference region the request was pinned to, or null for global routing. */
  inference_region: string | null;
};

export type MicrodollarUsageContext = SharedUsageRecordFields & {
  /** Context always knows the kind; the row column is nullable. */
  api_kind: GatewayApiKind;
  kiloUserId: string;
  fraudHeaders: FraudDetectionHeaders;
  organizationId?: Organization['id'];
  provider: ProviderType;
  requested_model: string;
  /** Context is immutable and always known; the row column is nullable. */
  readonly is_free: boolean;
  /** The requested custom LLM's pricing, which takes precedence over custom pricing. */
  custom_llm_pricing: CustomPricingTiers | null;
  promptInfo: PromptInfo;
  /** The row stores the same fact as `streamed`. */
  isStreaming: boolean;
  prior_microdollar_usage: number;
  /** User email for authenticated users - used as PostHog distinctId. Undefined for anonymous users. */
  posthog_distinct_id?: string;
  project_id: string | null;
  // The row stores the same fact as `is_user_byok`.
  /** True if user/org is using their own API key - cost should be zeroed out */
  user_byok: boolean;
  /** Context always decides this; the row column is nullable for older senders. */
  has_tools: boolean;
  // Context carries the validated feature value; the row stores it as plain text.
  /** Which product feature generated this API call. NULL if header not sent. */
  feature: FeatureValue | null;
  /**
   * Time until the upstream response headers arrived, in milliseconds. Stored as
   * `latency` only when the usage stats do not carry a measured latency.
   */
  ttfb_ms: number | null;
  /**
   * `performance.now()` when the gateway received the request. Usage processing
   * measures `latency` from it until the first response chunk.
   */
  requestStartedAt?: number;
  /**
   * Client-supplied per-message id from the `x-kilo-request` header.
   * Joinable to PostHog `Feedback Submitted.parentMessageID`. Optional
   * because pre-existing construction sites (routes, tests, dev helpers)
   * do not need to know about it.
   */
  clientRequestId?: string | null;
  /**
   * Report-only bouncer telemetry. Set on every gateway inference request that
   * reports a usage event; absent only on the internal classifier overhead row.
   */
  bouncer?: BouncerUsageContext;
  /**
   * The `microdollar_usage` id, chosen before the upstream request so records written outside
   * usage accounting can be keyed by it. Only a context that yields a single usage row may set
   * it: a second row with the same id would be dropped as a redelivery and go unbilled.
   */
  usageId?: string;
  providerMetadataCapture?: AiProviderMetadataCapture;
};

/**
 * Bouncer telemetry for the usage event. The decide verdict can reject a request before upstream;
 * once usage accounting runs, nothing here changes billing or the response, and the client
 * resolves even when the worker is unreachable.
 */
export type BouncerUsageContext = {
  /** Per-request id, also sent to bouncer's `decide` for the same request. */
  requestId: string;
  /** Wall-clock time the request started. */
  occurredAt: Date;
  /**
   * The payer key bouncer uses: `org:<id>` for an org request, `user:<id>` otherwise. An org
   * request carries the root organization of its family, the same key its decide uses.
   * Null for an anonymous request, which bouncer keys on the IP instead and must
   * never turn into a payer-sharing row.
   */
  accountId: string | null;
  /** The request's client IP as a bare IPv4/IPv6 literal, when one resolved. */
  clientIp?: string | null;
  /** A known Kilo feature value or a Kilo client version header was sent. */
  clientAttributed: boolean;
  /** The request set `logprobs`, `top_logprobs`, or a non-empty `logit_bias`. */
  requestedLogprobs: boolean;
  /** The `n` sampling parameter, or null when the request did not set one. */
  samples: number | null;
  /** SimHash of the last user turn. The context never carries the prompt text itself. */
  promptSimHash: string | null;
  /**
   * The decide verdict said `spendWatch`: the usage event goes through the durable usage-event
   * outbox instead of the best-effort send. Set after decide resolves; absent means false.
   */
  spendWatch?: boolean;
};

export type CoreUsageWithMetaData = {
  core: MicrodollarUsage;
  metadata: UsageMetaData;
};

export type BalanceUpdateResult = { newMicrodollarsUsed: number } | null;

/**
 * Identity of a persisted `microdollar_usage` row, as reported by the write.
 *
 * This lives here rather than in `processUsage.ts` because
 * `usage-record-client.ts` needs it while `processUsage.ts` imports that client:
 * declaring it there makes the two modules mutually dependent, which the
 * `dependency-cycle-check` script rejects even for type-only imports.
 */
export type UsageRecordInsertResult = {
  usageId: string;
  createdAt: string;
  newMicrodollarsUsed: number | null;
};

/**
 * A write outcome that also says whether this delivery is the one that inserted
 * the row. `wasRedelivery` is true when the identity was recovered from a row a
 * previous delivery had already committed, which is the signal callers need to
 * keep once-per-usage side effects at once per usage. It stays on the writing
 * side: the wire contract intentionally does not carry it, because every side
 * effect is decided where the write runs.
 */
export type UsageRecordWriteOutcome = UsageRecordInsertResult & { wasRedelivery: boolean };

/** Queued identity is generated by the gateway; it does not promise a committed row. */
export type UsageAccountingResult = {
  status: 'recorded' | 'queued';
  usageId: string;
  createdAt: string;
};

export type UsageMetaData = SharedUsageRecordFields & {
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
  upstream_id: string | null;
  finish_reason: string | null;
  latency: number | null;
  moderation_latency: number | null;
  generation_time: number | null;
  is_byok: boolean | null;
  /** Carries the context's `user_byok`. */
  is_user_byok: boolean;
  /** Carries the context's `isStreaming`. */
  streamed: boolean | null;
  cancelled: boolean | null;
  /** Widened row column: the context always knows the value, the column is nullable. */
  api_kind: GatewayApiKind | null;
  /** Widened row column: the context always decides this, the column is nullable for older senders. */
  has_tools: boolean | null;
  /** Widened row column: the context carries the validated value, the column is plain text. */
  feature: string | null;
  /** The same microdollar value the stats carry as `market_cost`. */
  market_cost: number | null;
  /** The same microdollar value the stats carry as `nonInferenceCost_mUsd`. */
  non_inference_cost: number | null;
  /** Widened row column: the context always knows the value, the column is nullable. */
  is_free: boolean | null;
  abuse_delay: number | null;
  abuse_downgraded_from: string | null;
};
