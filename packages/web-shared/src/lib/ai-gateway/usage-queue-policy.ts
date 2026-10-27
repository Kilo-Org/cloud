import 'server-only';

import { createHash } from 'node:crypto';
import type { UsageQueueSfoConfig } from './usage-queue-config';

export function isSfoUsageQueueSelected(
  config: UsageQueueSfoConfig,
  context: { kiloUserId: string; organizationId?: string }
): boolean {
  if (
    !config.enabled ||
    config.exposure === 0 ||
    !context.kiloUserId ||
    (config.userIds !== null && !config.userIds.has(context.kiloUserId))
  ) {
    return false;
  }

  // Versioned payer hashing keeps retries and requests in the same growing cohort.
  const payerKey = context.organizationId
    ? `org:${context.organizationId.toLowerCase()}`
    : `user:${context.kiloUserId}`;
  const bucket =
    createHash('sha256').update(`usage-sfo-v1:${payerKey}`).digest().readUInt32BE(0) % 10_000;
  return bucket < config.exposure * 10_000;
}
