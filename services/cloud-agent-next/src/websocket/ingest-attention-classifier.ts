/**
 * Attention event classifier for kilocode ingest events.
 *
 * Classifies question and permission events into raise/resolve intents
 * for the session attention system. The classifier is pure and synchronous,
 * returning a stable requestId and intent or null for non-attention events.
 *
 * The wrapper's real-time shape spreads properties at the top level of `data`,
 * so we accept `data.properties.id` (authoritative) or `data.id` (fallback)
 * and validate at runtime.
 */

export type AttentionIntent = { raise: 'question' | 'permission' } | 'resolve';

export type AttentionEvent = {
  requestId: string;
  intent: AttentionIntent;
};

const RAISE_KILO_EVENTS: ReadonlyMap<string, 'question' | 'permission'> = new Map([
  ['question.asked', 'question'],
  ['permission.asked', 'permission'],
]);

const RESOLVE_KILO_EVENTS: ReadonlySet<string> = new Set([
  'question.replied',
  'question.rejected',
  'permission.replied',
]);

/**
 * Classify a kilocode ingest event for the attention system.
 *
 * Returns a stable requestId and intent, or null when the event is not
 * attention-relevant. The wrapper's real-time shape spreads properties at
 * the top level of `data`, so we accept `data.properties.id` (authoritative)
 * or `data.id` (fallback) and validate at runtime.
 *
 * @param data - The kilocode event data (already validated as an object)
 * @returns AttentionEvent with requestId and intent, or null
 */
export function classifyAttentionKilocodeEvent(data: unknown): AttentionEvent | null {
  if (typeof data !== 'object' || data === null) return null;
  const dataRecord = data as Record<string, unknown>;
  const eventName = typeof dataRecord.event === 'string' ? dataRecord.event : undefined;
  if (!eventName) return null;

  let intent: AttentionIntent | null = null;
  const raiseKind = RAISE_KILO_EVENTS.get(eventName);
  if (raiseKind !== undefined) {
    intent = { raise: raiseKind };
  } else if (RESOLVE_KILO_EVENTS.has(eventName)) {
    intent = 'resolve';
  } else {
    return null;
  }

  // Resolve stable requestId: authoritative data.properties.id, fallback data.id
  const properties = dataRecord.properties;
  let requestId: unknown;
  if (typeof properties === 'object' && properties !== null) {
    requestId = (properties as Record<string, unknown>).id;
  }
  if (typeof requestId !== 'string' || requestId.length === 0) {
    requestId = dataRecord.id;
  }
  if (typeof requestId !== 'string' || requestId.length === 0) {
    return null;
  }

  return { requestId, intent };
}
