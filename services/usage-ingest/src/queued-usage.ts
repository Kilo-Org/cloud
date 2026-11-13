import {
  EnkryptUsageQueueMessageSchema,
  ExaUsageQueueMessageSchema,
  UsageRecordRequestSchema,
  type EnkryptUsageWrite,
  type ExaUsageRecord,
  type LlmUsageQueueMessage,
} from '@kilocode/usage-contracts';

type TaggedKind = 'enkrypt_usage' | 'exa_usage';

export type QueuedUsage =
  | { kind: 'llm'; usage: LlmUsageQueueMessage }
  | { kind: 'enkrypt_usage'; record: EnkryptUsageWrite }
  | { kind: 'exa_usage'; record: ExaUsageRecord }
  | {
      kind: 'invalid';
      usageKind: 'llm' | TaggedKind | 'unknown';
      reason: 'invalid_event' | 'unsupported_kind';
    };

function isTaggedKind(kind: unknown): kind is TaggedKind {
  return kind === 'enkrypt_usage' || kind === 'exa_usage';
}

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
  if (!isTaggedKind(tagged.kind)) {
    return { kind: 'invalid', usageKind: 'unknown', reason: 'unsupported_kind' };
  }
  if (tagged.v !== 1) {
    return { kind: 'invalid', usageKind: tagged.kind, reason: 'unsupported_kind' };
  }
  if (tagged.kind === 'exa_usage') {
    const parsed = ExaUsageQueueMessageSchema.safeParse(body);
    return parsed.success
      ? { kind: 'exa_usage', record: parsed.data.record }
      : { kind: 'invalid', usageKind: 'exa_usage', reason: 'invalid_event' };
  }
  const parsed = EnkryptUsageQueueMessageSchema.safeParse(body);
  return parsed.success
    ? { kind: 'enkrypt_usage', record: parsed.data.record }
    : { kind: 'invalid', usageKind: 'enkrypt_usage', reason: 'invalid_event' };
}
