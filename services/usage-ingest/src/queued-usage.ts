import {
  EnkryptUsageQueueMessageSchema,
  UsageRecordRequestSchema,
  type EnkryptUsageWrite,
  type LlmUsageQueueMessage,
} from '@kilocode/usage-contracts';

export type QueuedUsage =
  | { kind: 'llm'; usage: LlmUsageQueueMessage }
  | { kind: 'enkrypt_usage'; record: EnkryptUsageWrite }
  | {
      kind: 'invalid';
      usageKind: 'llm' | 'enkrypt_usage' | 'unknown';
      reason: 'invalid_event' | 'unsupported_kind';
    };

/**
 * LLM usage is published untagged, and its ingress schema strips unknown keys, so a body with its
 * own `kind` key is always a tagged non-LLM message.
 */
export function parseQueuedUsage(body: unknown): QueuedUsage {
  if (typeof body !== 'object' || body === null || !Object.hasOwn(body, 'kind')) {
    const parsed = UsageRecordRequestSchema.safeParse(body);
    return parsed.success
      ? { kind: 'llm', usage: parsed.data }
      : { kind: 'invalid', usageKind: 'llm', reason: 'invalid_event' };
  }
  const tagged: { kind?: unknown; v?: unknown } = body;
  if (tagged.kind !== 'enkrypt_usage') {
    return { kind: 'invalid', usageKind: 'unknown', reason: 'unsupported_kind' };
  }
  if (tagged.v !== 1) {
    return { kind: 'invalid', usageKind: 'enkrypt_usage', reason: 'unsupported_kind' };
  }
  const parsed = EnkryptUsageQueueMessageSchema.safeParse(body);
  return parsed.success
    ? { kind: 'enkrypt_usage', record: parsed.data.record }
    : { kind: 'invalid', usageKind: 'enkrypt_usage', reason: 'invalid_event' };
}
