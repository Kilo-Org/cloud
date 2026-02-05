/**
 * Client module for communicating with the Kilo Abuse Detection Service
 */

import { type NextRequest } from 'next/server';
import {
  ABUSE_SERVICE_CF_ACCESS_CLIENT_ID,
  ABUSE_SERVICE_CF_ACCESS_CLIENT_SECRET,
  ABUSE_SERVICE_URL,
} from '@/lib/config.server';
import { getFraudDetectionHeaders } from '@/lib/utils';
import type { OpenRouterChatCompletionRequest } from '@/lib/providers/openrouter/types';
import 'server-only';

/**
 * Extract full prompts from an OpenRouter chat completion request.
 * Unlike extractPromptInfo (which truncates to 100 chars), this returns full content for abuse analysis.
 */
function extractFullPrompts(body: OpenRouterChatCompletionRequest): {
  systemPrompt: string | null;
  userPrompt: string | null;
} {
  const messages = body.messages ?? [];

  const systemPrompt =
    messages
      .filter(m => m.role === 'system' || m.role === 'developer')
      .map(extractMessageTextContent)
      .join('\n') || null;

  const userPrompt =
    messages
      .filter(m => m.role === 'user')
      .map(extractMessageTextContent)
      .at(-1) ?? null;

  return { systemPrompt, userPrompt };
}

type Message = {
  role: string;
  content?: string | { type?: string; text?: string }[];
};

function extractMessageTextContent(m: Message): string {
  if (typeof m.content === 'string') {
    return m.content;
  }
  if (Array.isArray(m.content)) {
    return m.content
      .filter(c => c.type === 'text')
      .map(c => c.text ?? '')
      .join('\n');
  }
  return '';
}

/**
 * Verdict types that indicate the action the gateway should take
 */
export type Verdict = 'ALLOW' | 'CHALLENGE' | 'SOFT_BLOCK' | 'HARD_BLOCK';

/**
 * Signal types indicating which specific heuristics triggered
 */
export type AbuseSignal =
  | 'high_velocity'
  | 'free_tier_exhausted'
  | 'premium_harvester'
  | 'suspicious_fingerprint'
  | 'datacenter_ip'
  | 'known_abuser';

/**
 * Challenge types for the CHALLENGE verdict
 */
export type ChallengeType = 'turnstile' | 'payment_verification';

/**
 * Action metadata containing operational instructions for the gateway
 */
export type ActionMetadata = {
  /** If verdict is CHALLENGE, the type of challenge to present */
  challenge_type?: ChallengeType;
  /** If verdict is SOFT_BLOCK, silently route to this cheaper model */
  model_override?: string;
  /** Suggested retry delay in seconds */
  retry_after_seconds?: number;
};

/**
 * Context information for debugging and observability
 */
export type ClassificationContext = {
  /** The resolved identity key used for tracking */
  identity_key: string;
  /** Current spend in USD over the last hour */
  current_spend_1h: number;
  /** Whether this identity was first seen within the last hour */
  is_new_user: boolean;
  /** Current request rate (requests per second over the last minute) */
  requests_per_second: number;
};

/**
 * Response returned by the /api/classify endpoint
 */
export type AbuseClassificationResponse = {
  /** High-level decision for the gateway */
  verdict: Verdict;
  /** Risk score from 0.0 (safe) to 1.0 (definite abuse) */
  risk_score: number;
  /** Which specific heuristics triggered */
  signals: AbuseSignal[];
  /** Specific operational instructions for the gateway */
  action_metadata: ActionMetadata;
  /** State context for debugging headers */
  context: ClassificationContext;
  /** Request ID for correlating with cost updates. 0 indicates an error during classification. */
  request_id: number;
};

/**
 * Request payload matching the microdollar_usage_view schema
 * Sent from the Next.js API to classify a request for potential abuse
 */
export type UsagePayload = {
  // Identity fields
  id?: string;
  kilo_user_id?: string | null;
  organization_id?: string | null;
  project_id?: string | null;
  message_id?: string | null;

  // Cost tracking (in microdollars - divide by 1_000_000 for USD)
  cost?: number | null;
  cache_discount?: number | null;

  // Token usage
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_write_tokens?: number | null;
  cache_hit_tokens?: number | null;

  // Request metadata
  ip_address?: string | null;
  geo_city?: string | null;
  geo_country?: string | null;
  geo_latitude?: number | null;
  geo_longitude?: number | null;
  ja4_digest?: string | null;
  user_agent?: string | null;

  // Model information
  provider?: string | null;
  model?: string | null;
  requested_model?: string | null;
  inference_provider?: string | null;

  // Prompt content (full prompts for storage and analysis)
  user_prompt?: string | null;
  system_prompt?: string | null;
  max_tokens?: number | null;
  has_middle_out_transform?: boolean | null;
  has_tools?: boolean | null;
  streamed?: boolean | null;

  // Response metadata
  status_code?: number | null;
  upstream_id?: string | null;
  finish_reason?: string | null;
  has_error?: boolean | null;
  cancelled?: boolean | null;

  // Timing
  created_at?: string | null;
  latency?: number | null;
  moderation_latency?: number | null;
  generation_time?: number | null;

  // User context
  is_byok?: boolean | null;
  is_user_byok?: boolean | null;
  editor_name?: string | null;

  // Existing classification (if any)
  abuse_classification?: number | null;
};

/**
 * Classify a request for potential abuse.
 * This is called before proxying requests to detect fraudulent activity.
 *
 * Currently logs the response only; does not take action.
 *
 * @param payload - Request details to classify
 * @returns Classification response or null if service unavailable
 */
export async function classifyRequest(
  payload: UsagePayload
): Promise<AbuseClassificationResponse | null> {
  if (!ABUSE_SERVICE_URL) {
    return null;
  }

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add Cloudflare Access headers for authentication
    if (ABUSE_SERVICE_CF_ACCESS_CLIENT_ID && ABUSE_SERVICE_CF_ACCESS_CLIENT_SECRET) {
      headers['CF-Access-Client-Id'] = ABUSE_SERVICE_CF_ACCESS_CLIENT_ID;
      headers['CF-Access-Client-Secret'] = ABUSE_SERVICE_CF_ACCESS_CLIENT_SECRET;
    }

    const response = await fetch(`${ABUSE_SERVICE_URL}/api/classify`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(`Abuse service error (${response.status}): ${await response.text()}`);
      return null;
    }

    return (await response.json()) as AbuseClassificationResponse;
  } catch (error) {
    // Fail-open: don't block requests if abuse service is down
    console.error('Abuse classification failed:', error);
    return null;
  }
}

/**
 * Request payload for reporting cost to the abuse service after request completion.
 * Enables spend-based heuristics like free_tier_exhausted.
 */
type CostUpdatePayload = {
  // Identity fields (must match what was sent to /classify)
  kilo_user_id?: string | null;
  ip_address?: string | null;
  ja4_digest?: string | null;
  user_agent?: string | null;

  // Request identification (REQUIRED)
  request_id: number; // From classify response, for correlation
  message_id: string; // From LLM response, for analytics

  // Cost data (REQUIRED, in microdollars)
  cost: number;
  requested_model?: string | null;

  // Token counts (optional but recommended)
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_write_tokens?: number | null;
  cache_hit_tokens?: number | null;
};

/**
 * Response from the cost update endpoint
 */
export type CostUpdateResponse = {
  success: boolean;
  identity_key?: string;
  message_id?: string;
  do_updated?: boolean;
  error?: string;
};

/**
 * Report cost to the abuse service after a request completes.
 * This enables spend-based heuristics like free_tier_exhausted.
 *
 * This is fire-and-forget - failures are logged but don't affect the user.
 *
 * @param payload - Cost and identity data to report
 * @returns Response or null if service unavailable/failed
 */
export async function reportCost(payload: CostUpdatePayload): Promise<CostUpdateResponse | null> {
  if (!ABUSE_SERVICE_URL) {
    return null;
  }

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add Cloudflare Access headers in production
    if (ABUSE_SERVICE_CF_ACCESS_CLIENT_ID && ABUSE_SERVICE_CF_ACCESS_CLIENT_SECRET) {
      headers['CF-Access-Client-Id'] = ABUSE_SERVICE_CF_ACCESS_CLIENT_ID;
      headers['CF-Access-Client-Secret'] = ABUSE_SERVICE_CF_ACCESS_CLIENT_SECRET;
    }

    const response = await fetch(`${ABUSE_SERVICE_URL}/api/usage/cost`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(`[Abuse] Cost update failed (${response.status}): ${await response.text()}`);
      return null;
    }

    return (await response.json()) as CostUpdateResponse;
  } catch (error) {
    // Log but don't throw - this shouldn't affect user experience
    console.error('[Abuse] Failed to report cost:', error);
    return null;
  }
}

/**
 * Context needed to classify abuse for a request.
 * All fields are optional to allow classification early in the request lifecycle.
 */
export type AbuseClassificationContext = {
  kiloUserId?: string | null;
  organizationId?: string | null;
  projectId?: string | null;
  provider?: string | null;
  isByok?: boolean | null;
};

/**
 * High-level function to classify a request for abuse.
 * Extracts all needed info from the request and body automatically.
 *
 * @param request - The incoming NextRequest
 * @param body - The parsed OpenRouter request body
 * @param context - Additional context (user, org, provider info)
 * @returns Classification response or null if service unavailable
 */
export async function classifyAbuse(
  request: NextRequest,
  body: OpenRouterChatCompletionRequest,
  context?: AbuseClassificationContext
): Promise<AbuseClassificationResponse | null> {
  const fraudHeaders = getFraudDetectionHeaders(request.headers);
  const { systemPrompt, userPrompt } = extractFullPrompts(body);

  const payload: UsagePayload = {
    kilo_user_id: context?.kiloUserId ?? null,
    organization_id: context?.organizationId ?? null,
    project_id: context?.projectId ?? null,
    ip_address: fraudHeaders.http_x_forwarded_for,
    geo_city: fraudHeaders.http_x_vercel_ip_city,
    geo_country: fraudHeaders.http_x_vercel_ip_country,
    geo_latitude: fraudHeaders.http_x_vercel_ip_latitude,
    geo_longitude: fraudHeaders.http_x_vercel_ip_longitude,
    ja4_digest: fraudHeaders.http_x_vercel_ja4_digest,
    user_agent: fraudHeaders.http_user_agent,
    provider: context?.provider ?? null,
    requested_model: body.model?.toLowerCase() ?? null,
    user_prompt: userPrompt,
    system_prompt: systemPrompt,
    max_tokens: body.max_tokens ?? null,
    has_middle_out_transform: body.transforms?.includes('middle-out') ?? false,
    has_tools: (body.tools?.length ?? 0) > 0,
    streamed: body.stream === true,
    is_user_byok: context?.isByok ?? null,
    editor_name: request.headers.get('x-kilocode-editorname') ?? null,
  };

  return classifyRequest(payload);
}

/**
 * Report cost to the abuse service after a request completes.
 * Call this after the LLM response is processed and usage stats are available.
 *
 * Requires usageContext.abuse_request_id (from classify response) and
 * usageStats.messageId (from LLM response). Skips if either is missing
 * or if abuse_request_id is 0 (indicates classification error).
 *
 * Use fire-and-forget pattern since this shouldn't block:
 *   reportAbuseCost(usageContext, usageStats).catch(console.error)
 */
export async function reportAbuseCost(
  usageContext: {
    kiloUserId: string;
    fraudHeaders: {
      http_x_forwarded_for: string | null;
      http_x_vercel_ja4_digest: string | null;
      http_user_agent: string | null;
    };
    requested_model: string;
    abuse_request_id?: number;
  },
  usageStats: {
    messageId: string | null;
    cost_mUsd: number;
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheHitTokens: number;
  }
): Promise<CostUpdateResponse | null> {
  // Skip if missing required fields or request_id is 0 (classification error)
  if (!usageContext.abuse_request_id || !usageStats.messageId) {
    return null;
  }

  return reportCost({
    kilo_user_id: usageContext.kiloUserId,
    ip_address: usageContext.fraudHeaders.http_x_forwarded_for,
    ja4_digest: usageContext.fraudHeaders.http_x_vercel_ja4_digest,
    user_agent: usageContext.fraudHeaders.http_user_agent,
    request_id: usageContext.abuse_request_id,
    message_id: usageStats.messageId,
    cost: usageStats.cost_mUsd,
    requested_model: usageContext.requested_model,
    input_tokens: usageStats.inputTokens,
    output_tokens: usageStats.outputTokens,
    cache_write_tokens: usageStats.cacheWriteTokens,
    cache_hit_tokens: usageStats.cacheHitTokens,
  });
}
