import 'server-only';

import { createHash } from 'node:crypto';
import type { UsageQueueFraConfig, UsageQueueSfoConfig } from './usage-queue-config';

type UsageQueuePayer = { kiloUserId: string; organizationId?: string };

export function isSfoUsageQueueSelected(
  config: UsageQueueSfoConfig,
  context: UsageQueuePayer
): boolean {
  if (
    !config.enabled ||
    config.exposure === 0 ||
    !context.kiloUserId ||
    (config.userIds !== null && !config.userIds.has(context.kiloUserId))
  ) {
    return false;
  }

  return usageQueuePayerBucket(context, 'usage-sfo-v1') < config.exposure * 10_000;
}

export function isFraUsageQueueSelected(
  config: UsageQueueFraConfig,
  context: UsageQueuePayer
): boolean {
  return (
    config.enabled &&
    config.exposure > 0 &&
    !!context.kiloUserId &&
    usageQueuePayerBucket(context, 'usage-fra-v1') < config.exposure * 10_000
  );
}

function usageQueuePayerBucket(context: UsageQueuePayer, seed: string): number {
  // Versioned payer hashing keeps retries and requests in the same growing cohort.
  const payerKey = context.organizationId
    ? `org:${context.organizationId.toLowerCase()}`
    : `user:${context.kiloUserId}`;
  return createHash('sha256').update(`${seed}:${payerKey}`).digest().readUInt32BE(0) % 10_000;
}
