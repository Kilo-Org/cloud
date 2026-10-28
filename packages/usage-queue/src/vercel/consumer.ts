import 'server-only';

import type { MessageMetadata } from '@vercel/queue';
import { UsageRecordRequestSchema } from '@kilocode/usage-contracts';
import { recordUsage } from '@kilocode/worker-utils/usage-writer-client';
import { verifyUsageMessage, VERCEL_USAGE_TOPIC } from './message';
const getEnvVariable = (key: string) => process.env[key] || '';

export async function consumeVercelUsage(
  message: unknown,
  metadata: MessageMetadata
): Promise<void> {
  const executionRegion = getEnvVariable('VERCEL_REGION');
  const context = {
    transport: 'vercel',
    messageId: metadata.messageId,
    delivery_attempt: metadata.deliveryCount,
    queue_region: metadata.region,
    execution_region:
      executionRegion === 'fra1' || executionRegion === 'sfo1' ? executionRegion : 'unknown',
    queue_age_ms: Math.max(0, Date.now() - metadata.createdAt.getTime()),
  };
  // Independent of the publishing flag so previous staging deployments can drain.
  if (
    getEnvVariable('VERCEL_TARGET_ENV') !== 'staging' ||
    getEnvVariable('VERCEL_ENV') === 'production'
  ) {
    console.error('usage queue consumer failed', { ...context, reason: 'not_staging' });
    throw new Error('usage queue consumer requires staging');
  }
  const authenticated =
    metadata.topicName === VERCEL_USAGE_TOPIC
      ? await verifyUsageMessage(message, getEnvVariable('USAGE_WRITER_SECRET'))
      : null;
  if (!authenticated) {
    console.error('usage queue consumer failed', { ...context, reason: 'unauthenticated_message' });
    throw new Error('unauthenticated usage queue message');
  }
  const parsed = UsageRecordRequestSchema.safeParse(authenticated.payload);
  if (!parsed.success) {
    console.error('usage queue consumer failed', { ...context, reason: 'invalid_payload' });
    throw new Error('invalid usage queue payload');
  }
  const usageId = parsed.data.core.id;
  console.info('usage queue consumer started', { ...context, usageId });
  const startedAt = performance.now();
  const outcome = await recordUsage(parsed.data, {
    url: getEnvVariable('USAGE_WRITER_URL'),
    secret: getEnvVariable('USAGE_WRITER_SECRET'),
    protectionBypass: getEnvVariable('USAGE_WRITER_PROTECTION_BYPASS'),
    source: 'queue_vercel',
  });
  const completion = {
    ...context,
    usageId,
    outcome: outcome.kind,
    writer_http_duration_ms: Math.round(performance.now() - startedAt),
  };
  if (outcome.kind === 'unavailable') {
    console.warn('usage queue consumer failed', {
      ...completion,
      reason: outcome.reason,
      status: outcome.status,
    });
    // Returning normally auto-acks. Even not_recorded must remain retryable.
    throw new Error(`usage writer unavailable: ${outcome.reason}`);
  }
  console.info('usage queue consumer completed', completion);
}
