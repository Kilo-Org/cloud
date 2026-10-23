import 'server-only';
import type { NextRequest } from 'next/server';
import { isFirewallRateLimited } from '@kilocode/web-shared/lib/ai-gateway/firewall-rate-limit';

/**
 * Vercel Firewall rate limits shared by all free models, custom LLMs excluded.
 * They exist to stop abuse, not to meter normal use. Signed-in callers count
 * per account and anonymous callers per IP, each against its own rule so the
 * two limits can differ. Abusers rotate IPs far more cheaply than accounts, and
 * people behind one NAT should not share an allowance. The windows and limits
 * live in the project's firewall configuration.
 */
export type FreeModelRateLimitSubject =
  | { kind: 'account'; kiloUserId: string }
  | { kind: 'ip'; ipAddress: string };

const FREE_MODEL_RATE_LIMIT_RULES = {
  account: { id: 'free-model-inference-user', sentrySource: 'free_model_inference_user' },
  ip: { id: 'free-model-inference', sentrySource: 'free_model_inference' },
} as const;

export function freeModelRateLimitKey(subject: FreeModelRateLimitSubject): string {
  return subject.kind === 'account' ? `user:${subject.kiloUserId}` : `ip:${subject.ipAddress}`;
}

export function isFreeModelRateLimited(
  request: NextRequest,
  subject: FreeModelRateLimitSubject
): Promise<boolean> {
  return isFirewallRateLimited(request, {
    ...FREE_MODEL_RATE_LIMIT_RULES[subject.kind],
    key: freeModelRateLimitKey(subject),
  });
}
