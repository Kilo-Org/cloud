import 'server-only';

import type { UsageQueueFraConfig, UsageQueueSfoConfig } from './usage-queue-config';

type UsageQueuePayer = { kiloUserId: string; organizationId?: string };

export function isSfoUsageQueueSelected(
  config: UsageQueueSfoConfig,
  context: UsageQueuePayer
): boolean {
  return config.enabled && !!context.kiloUserId;
}

export function isFraUsageQueueSelected(
  config: UsageQueueFraConfig,
  context: UsageQueuePayer
): boolean {
  return config.enabled && !!context.kiloUserId;
}
