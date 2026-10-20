import 'server-only';
import type { NextRequest } from 'next/server';
import { checkFirewallRateLimit } from '@kilocode/web-shared/lib/ai-gateway/firewall-rate-limit';

/**
 * Vercel Firewall rate limit for the free models flagged `rate-limited`, which
 * free users reach through `kilo-auto/small` for session titles and other small
 * tasks. It exists to stop obvious abuse, not to meter normal use. The window
 * and limit live in the project's firewall configuration.
 */
const FREE_MODEL_RATE_LIMIT_ID = 'free-model-inference';

/**
 * A missing rule keeps this cap open on purpose. It is a fairness cap on free
 * models, not an admission control: refusing free-model traffic because the
 * rule is absent would take a working route down, and the volume it guards is
 * small. The account inference cap, which does guard admission, fails closed.
 */
export async function isFreeModelRateLimited(request: NextRequest, key: string): Promise<boolean> {
  const verdict = await checkFirewallRateLimit(request, {
    id: FREE_MODEL_RATE_LIMIT_ID,
    key,
    sentrySource: 'free_model_inference',
  });
  return verdict === 'limited';
}
