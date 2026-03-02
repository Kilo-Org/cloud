import type { OpenRouterChatCompletionRequest } from '@kilocode/llm-shared';
import { logger } from '../logger.js';

type Verdict = 'ALLOW' | 'CHALLENGE' | 'SOFT_BLOCK' | 'HARD_BLOCK';

type AbuseSignal =
  | 'high_velocity'
  | 'free_tier_exhausted'
  | 'premium_harvester'
  | 'suspicious_fingerprint'
  | 'datacenter_ip'
  | 'known_abuser';

type ClassificationContext = {
  identity_key: string;
  current_spend_1h: number;
  is_new_user: boolean;
  requests_per_second: number;
};

export type AbuseClassificationResponse = {
  verdict: Verdict;
  risk_score: number;
  signals: AbuseSignal[];
  action_metadata: {
    challenge_type?: 'turnstile' | 'payment_verification';
    model_override?: string;
    retry_after_seconds?: number;
  };
  context: ClassificationContext;
  request_id: number;
};

type UsagePayload = {
  kilo_user_id?: string | null;
  organization_id?: string | null;
  project_id?: string | null;
  ip_address?: string | null;
  geo_city?: string | null;
  geo_country?: string | null;
  geo_latitude?: number | null;
  geo_longitude?: number | null;
  ja4_digest?: string | null;
  user_agent?: string | null;
  provider?: string | null;
  requested_model?: string | null;
  user_prompt?: string | null;
  system_prompt?: string | null;
  max_tokens?: number | null;
  has_middle_out_transform?: boolean | null;
  has_tools?: boolean | null;
  streamed?: boolean | null;
  is_user_byok?: boolean | null;
  editor_name?: string | null;
};

export type AbuseEnv = {
  ABUSE_SERVICE_URL?: string;
  ABUSE_SERVICE_CF_ACCESS_CLIENT_ID?: string;
  ABUSE_SERVICE_CF_ACCESS_CLIENT_SECRET?: string;
};

type AbuseClassificationContext = {
  kiloUserId: string;
  organizationId: string | undefined;
  projectId: string | null;
  provider: string;
  isByok: boolean;
};

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

function extractFullPrompts(body: OpenRouterChatCompletionRequest): {
  systemPrompt: string | null;
  userPrompt: string | null;
} {
  const messages = (body.messages ?? []) as Message[];

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

async function classifyRequest(
  payload: UsagePayload,
  env: AbuseEnv
): Promise<AbuseClassificationResponse | null> {
  if (!env.ABUSE_SERVICE_URL) {
    return null;
  }

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (env.ABUSE_SERVICE_CF_ACCESS_CLIENT_ID && env.ABUSE_SERVICE_CF_ACCESS_CLIENT_SECRET) {
      headers['CF-Access-Client-Id'] = env.ABUSE_SERVICE_CF_ACCESS_CLIENT_ID;
      headers['CF-Access-Client-Secret'] = env.ABUSE_SERVICE_CF_ACCESS_CLIENT_SECRET;
    }

    const response = await fetch(`${env.ABUSE_SERVICE_URL}/api/classify`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      logger.error(`Abuse service error (${response.status}): ${await response.text()}`);
      return null;
    }

    return (await response.json()) as AbuseClassificationResponse;
  } catch (error) {
    logger.error('Abuse classification failed', { error: String(error) });
    return null;
  }
}

export type CostUpdatePayload = {
  kilo_user_id?: string | null;
  ip_address?: string | null;
  ja4_digest?: string | null;
  user_agent?: string | null;
  request_id: number;
  message_id: string;
  cost: number;
  requested_model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_write_tokens?: number | null;
  cache_hit_tokens?: number | null;
};

export async function reportCost(
  payload: CostUpdatePayload,
  env: AbuseEnv
): Promise<{ success: boolean } | null> {
  if (!env.ABUSE_SERVICE_URL) {
    return null;
  }

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (env.ABUSE_SERVICE_CF_ACCESS_CLIENT_ID && env.ABUSE_SERVICE_CF_ACCESS_CLIENT_SECRET) {
      headers['CF-Access-Client-Id'] = env.ABUSE_SERVICE_CF_ACCESS_CLIENT_ID;
      headers['CF-Access-Client-Secret'] = env.ABUSE_SERVICE_CF_ACCESS_CLIENT_SECRET;
    }

    const response = await fetch(`${env.ABUSE_SERVICE_URL}/api/usage/cost`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      logger.error(`[Abuse] Cost update failed (${response.status}): ${await response.text()}`);
      return null;
    }

    return (await response.json()) as { success: boolean };
  } catch (error) {
    logger.error('[Abuse] Failed to report cost', { error: String(error) });
    return null;
  }
}

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
  },
  env: AbuseEnv
): Promise<{ success: boolean } | null> {
  if (!usageContext.abuse_request_id || !usageStats.messageId) {
    return null;
  }

  return reportCost(
    {
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
    },
    env
  );
}

// Non-blocking abuse classification call — fail-open with 2s timeout
export async function classifyAbuse(
  body: OpenRouterChatCompletionRequest,
  fraudHeaders: {
    http_x_forwarded_for: string | null;
    http_x_vercel_ip_city: string | null;
    http_x_vercel_ip_country: string | null;
    http_x_vercel_ip_latitude: number | null;
    http_x_vercel_ip_longitude: number | null;
    http_x_vercel_ja4_digest: string | null;
    http_user_agent: string | null;
  },
  editorName: string | null,
  context: AbuseClassificationContext,
  env: AbuseEnv
): Promise<AbuseClassificationResponse | null> {
  const { systemPrompt, userPrompt } = extractFullPrompts(body);

  const payload: UsagePayload = {
    kilo_user_id: context.kiloUserId,
    organization_id: context.organizationId ?? null,
    project_id: context.projectId,
    ip_address: fraudHeaders.http_x_forwarded_for,
    geo_city: fraudHeaders.http_x_vercel_ip_city,
    geo_country: fraudHeaders.http_x_vercel_ip_country,
    geo_latitude: fraudHeaders.http_x_vercel_ip_latitude,
    geo_longitude: fraudHeaders.http_x_vercel_ip_longitude,
    ja4_digest: fraudHeaders.http_x_vercel_ja4_digest,
    user_agent: fraudHeaders.http_user_agent,
    provider: context.provider,
    requested_model: body.model?.toLowerCase() ?? null,
    user_prompt: userPrompt,
    system_prompt: systemPrompt,
    max_tokens: body.max_tokens ?? null,
    has_middle_out_transform: body.transforms?.includes('middle-out') ?? false,
    has_tools: (body.tools?.length ?? 0) > 0,
    streamed: body.stream === true,
    is_user_byok: context.isByok,
    editor_name: editorName,
  };

  return classifyRequest(payload, env);
}
