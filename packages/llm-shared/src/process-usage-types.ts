import type { FeatureValue } from './feature-detection.js';
import type { ProviderId } from './provider-id.js';
import type { OpenRouterChatCompletionRequest } from './openrouter-types.js';

type FraudDetectionHeaders = {
  http_x_forwarded_for: string | null;
  http_x_vercel_ip_city: string | null;
  http_x_vercel_ip_country: string | null;
  http_x_vercel_ip_latitude: number | null;
  http_x_vercel_ip_longitude: number | null;
  http_x_vercel_ja4_digest: string | null;
  http_user_agent: string | null;
};

export type MicrodollarUsageContext = {
  kiloUserId: string;
  fraudHeaders: FraudDetectionHeaders;
  organizationId?: string;
  provider: ProviderId;
  requested_model: string;
  promptInfo: PromptInfo;
  max_tokens: number | null;
  has_middle_out_transform: boolean | null;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  isStreaming: boolean;
  prior_microdollar_usage: number;
  posthog_distinct_id?: string;
  project_id: string | null;
  status_code: number | null;
  editor_name: string | null;
  machine_id: string | null;
  user_byok: boolean;
  has_tools: boolean;
  botId?: string;
  tokenSource?: string;
  abuse_request_id?: number;
  feature: FeatureValue | null;
  session_id: string | null;
};

export type PromptInfo = {
  system_prompt_prefix: string;
  system_prompt_length: number;
  user_prompt_prefix: string;
};

interface Message {
  role: string;
  content?: string | { type?: string; text?: string }[];
  parts?: { text?: string }[];
}

const extractMessageTextContent = (m: Message) =>
  typeof m.content === 'string'
    ? m.content
    : Array.isArray(m.content)
      ? m.content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\n')
      : '';

export function extractPromptInfo(body: OpenRouterChatCompletionRequest): PromptInfo {
  try {
    const messages = body.messages ?? [];

    const systemPrompt = messages
      .filter(m => m.role === 'system' || m.role === 'developer')
      .map(extractMessageTextContent)
      .join('\n');

    const system_prompt_prefix = systemPrompt.slice(0, 100);
    const system_prompt_length = systemPrompt.length;

    const lastUserMessage =
      messages
        .filter(m => m.role === 'user')
        .slice(-1)
        .map(extractMessageTextContent)[0] ?? '';

    const user_prompt_prefix = lastUserMessage.slice(0, 100);

    return { system_prompt_prefix, system_prompt_length, user_prompt_prefix };
  } catch {
    return { system_prompt_prefix: '', system_prompt_length: -1, user_prompt_prefix: '' };
  }
}
