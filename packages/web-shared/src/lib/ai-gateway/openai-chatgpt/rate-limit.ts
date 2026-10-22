import 'server-only';
import type { NextRequest } from 'next/server';
import { isFirewallRateLimited } from '@kilocode/web-shared/lib/ai-gateway/firewall-rate-limit';
import { openAiChatGptOwnerKey, type OpenAiChatGptOwner } from './store';

/**
 * Vercel Firewall rate limit on requests served through a ChatGPT connection.
 * It exists to stop abuse, not to meter normal use: every connection shares
 * the partner project's OpenAI rate limits, so one connection driven by a relay
 * can exhaust them for every other person. Requests count per connection,
 * which is one ChatGPT plan, so rotating source addresses does not raise the
 * allowance. The window and limit live in the project's firewall configuration;
 * keep the window at ten minutes or longer, because the refusal tells clients
 * not to retry.
 */
const OPENAI_CHATGPT_RATE_LIMIT_RULE = {
  id: 'openai-chatgpt-inference',
  sentrySource: 'openai_chatgpt_inference',
} as const;

export function isOpenAiChatGptRateLimited(
  request: NextRequest,
  owner: OpenAiChatGptOwner
): Promise<boolean> {
  return isFirewallRateLimited(request, {
    ...OPENAI_CHATGPT_RATE_LIMIT_RULE,
    key: openAiChatGptOwnerKey(owner),
  });
}
