import 'server-only';
import type { NextRequest } from 'next/server';
import { isFirewallRateLimited } from '@kilocode/web-shared/lib/ai-gateway/firewall-rate-limit';

/**
 * Vercel Firewall rate limit shared by all free models, custom LLMs excluded.
 * It exists to stop obvious abuse, not to meter normal use. The window and
 * limit live in the project's firewall configuration.
 */
const FREE_MODEL_RATE_LIMIT_ID = 'free-model-inference';

export function isFreeModelRateLimited(request: NextRequest, key: string): Promise<boolean> {
  return isFirewallRateLimited(request, {
    id: FREE_MODEL_RATE_LIMIT_ID,
    key,
    sentrySource: 'free_model_inference',
  });
}
