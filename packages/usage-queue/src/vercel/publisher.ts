import 'server-only';

import { send } from '@vercel/queue';
import type { UsageRecordRequest } from '@kilocode/usage-contracts';
import { signUsageMessage, VERCEL_USAGE_TOPIC } from './message';
type UsageEnqueueOutcome = { kind: 'accepted' } | { kind: 'unavailable'; reason: string };

export { VERCEL_USAGE_TOPIC } from './message';
export const VERCEL_USAGE_REGION = 'fra1';
export const VERCEL_USAGE_RETENTION_SECONDS = 86_400;
export const VERCEL_USAGE_PUBLISH_TIMEOUT_MS = 2_000;

export async function enqueueVercelUsage(
  payload: UsageRecordRequest
): Promise<UsageEnqueueOutcome> {
  const startedAt = performance.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let publicationExpired = false;
  try {
    // The SDK has no send AbortSignal. A deadline is ambiguous acceptance, never
    // permission to publish to another transport or fall back to a direct write.
    const result = await Promise.race([
      signUsageMessage(payload, process.env.USAGE_WRITER_SECRET || '').then(async message => {
        // Signing may finish late; do not begin network I/O outside the caller's budget.
        if (publicationExpired) return 'timeout' as const;
        await send(VERCEL_USAGE_TOPIC, message, {
          region: VERCEL_USAGE_REGION,
          retentionSeconds: VERCEL_USAGE_RETENTION_SECONDS,
          idempotencyKey: payload.core.id,
        });
        return 'accepted' as const;
      }),
      new Promise<'timeout'>(resolve => {
        timeout = setTimeout(() => {
          publicationExpired = true;
          resolve('timeout');
        }, VERCEL_USAGE_PUBLISH_TIMEOUT_MS);
      }),
    ]);
    if (result === 'timeout') {
      console.warn('usage enqueue unavailable', {
        usageId: payload.core.id,
        transport: 'vercel',
        reason: 'acceptance_unknown',
        duration_ms: Math.round(performance.now() - startedAt),
      });
      return { kind: 'unavailable', reason: 'acceptance_unknown' };
    }
    console.info('usage enqueue accepted', {
      usageId: payload.core.id,
      transport: 'vercel',
      queue_region: VERCEL_USAGE_REGION,
      duration_ms: Math.round(performance.now() - startedAt),
    });
    return { kind: 'accepted' };
  } catch {
    console.warn('usage enqueue unavailable', {
      usageId: payload.core.id,
      transport: 'vercel',
      reason: 'publish_failed',
      duration_ms: Math.round(performance.now() - startedAt),
    });
    return { kind: 'unavailable', reason: 'publish_failed' };
  } finally {
    clearTimeout(timeout);
  }
}
