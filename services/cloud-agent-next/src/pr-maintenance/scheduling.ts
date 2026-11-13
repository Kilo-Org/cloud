import type { z } from 'zod';
import type { Env } from '../types.js';
import { logger } from '../logger.js';
import { readBoundedBody } from '../utils/read-bounded-body.js';
import { maintenanceDispatchResponseSchema, maintenanceScheduleSchema } from './contracts.js';

export const PR_MAINTENANCE_RECOVERY_CRON = '* * * * *';
export const PR_MAINTENANCE_MINIMUM_DELAY_SECONDS = 5;
export const PR_MAINTENANCE_DISPATCH_TIMEOUT_MS = 185_000;
export const PR_MAINTENANCE_QUEUES = new Set([
  'cloud-agent-next-pr-maintenance',
  'cloud-agent-next-pr-maintenance-dev',
]);

export async function scheduleMaintenance(
  env: Env,
  input: z.infer<typeof maintenanceScheduleSchema>
) {
  if (!env.PR_MAINTENANCE_QUEUE) throw new Error('maintenance_queue_unavailable');
  const delaySeconds = Math.min(
    86_400,
    Math.max(
      PR_MAINTENANCE_MINIMUM_DELAY_SECONDS,
      Math.ceil((Date.parse(input.dueAt) - Date.now()) / 1000)
    )
  );
  await env.PR_MAINTENANCE_QUEUE.send(input, { delaySeconds });
}

export async function dispatchDueMaintenance(env: Env, watchId?: string): Promise<void> {
  if (!env.INTERNAL_API_SECRET || !env.KILOCODE_BACKEND_BASE_URL) {
    throw new Error('maintenance_dispatch_configuration_unavailable');
  }
  const response = await fetch(
    new URL('/api/internal/cloud-agent/pr-maintenance/dispatch', env.KILOCODE_BACKEND_BASE_URL),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-api-key': env.INTERNAL_API_SECRET,
      },
      body: JSON.stringify({ ...(watchId ? { watchId } : {}), limit: 20 }),
      signal: AbortSignal.timeout(PR_MAINTENANCE_DISPATCH_TIMEOUT_MS),
    }
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`maintenance_dispatch_http_${response.status}`);
  }
  const body = await readBoundedBody(response, 16_384);
  let value: unknown;
  try {
    value = body === null ? null : JSON.parse(body);
  } catch {
    throw new Error('maintenance_dispatch_response_invalid');
  }
  const parsed = maintenanceDispatchResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error('maintenance_dispatch_response_invalid');
}

export async function consumeMaintenanceQueue(
  batch: MessageBatch<unknown>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    const parsed = maintenanceScheduleSchema.safeParse(message.body);
    if (!parsed.success) {
      logger.warn('PR maintenance schedule payload rejected');
      message.ack();
      continue;
    }
    const remaining = Date.parse(parsed.data.dueAt) - Date.now();
    if (remaining > 1000) {
      message.ack();
      continue;
    }
    try {
      await dispatchDueMaintenance(env, parsed.data.watchId);
      message.ack();
    } catch (error) {
      logger.warn('PR maintenance dispatch deferred', {
        reason: error instanceof Error ? error.message : 'unknown',
        deliveryAttempt: message.attempts,
      });
      message.retry({ delaySeconds: Math.min(300, 15 * 2 ** Math.min(message.attempts, 5)) });
    }
  }
}
