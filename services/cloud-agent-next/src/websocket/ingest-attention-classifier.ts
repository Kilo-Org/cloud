/**
 * Attention event classifier for kilocode ingest events.
 *
 * Classifies question and permission events into raise/resolve intents
 * for the session attention system. The classifier is pure and synchronous,
 * returning a stable requestId, intent, and (when present) the source
 * `kiloSessionId` so the caller can filter out events from child sessions
 * of this Cloud Agent run, or null for non-attention events.
 *
 * Authoritative id source per event family:
 * - raises (`question.asked`, `permission.asked`) → `properties.id`,
 *   top-level `data.id` is the fallback (the wrapper's real-time shape
 *   spreads properties at the top level of `data`).
 * - resolves (`question.replied`, `question.rejected`,
 *   `permission.replied`) → `properties.requestID`, top-level
 *   `data.requestID` is the fallback.
 *
 * The source `kiloSessionId` is extracted from `properties.sessionID`
 * (authoritative) or top-level `data.sessionID` (fallback). A qualifying
 * event without a non-empty source `sessionID` is ignored because the
 * scheduler cannot verify it belongs to the root session.
 */

export type AttentionIntent =
  | { raise: 'question' | 'permission' }
  | { resolve: 'question' | 'permission' };

export type AttentionEvent = {
  requestId: string;
  intent: AttentionIntent;
  sourceKiloSessionId: string;
};

const RAISE_KILO_EVENTS: ReadonlyMap<string, 'question' | 'permission'> = new Map([
  ['question.asked', 'question'],
  ['permission.asked', 'permission'],
]);

const RESOLVE_KILO_EVENTS: ReadonlyMap<string, 'question' | 'permission'> = new Map([
  ['question.replied', 'question'],
  ['question.rejected', 'question'],
  ['permission.replied', 'permission'],
]);

function readNonEmptyString(
  record: Record<string, unknown> | null,
  key: string
): string | undefined {
  if (!record) return undefined;
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readSessionIdFromRecord(record: Record<string, unknown> | null): string | undefined {
  if (!record) return undefined;
  return readNonEmptyString(record, 'sessionID');
}

/**
 * Classify a kilocode ingest event for the attention system.
 *
 * Returns a stable requestId and intent, or null when the event is not
 * attention-relevant. The wrapper's real-time shape spreads properties at
 * the top level of `data`, so we read the event-specific id from the
 * nested `properties` first and fall back to the top-level field. Resolves
 * prefer `requestID` over `id` (legacy); raises prefer `id`.
 *
 * @param data - The kilocode event data (already validated as an object)
 * @returns AttentionEvent with requestId and intent, or null
 */
export function classifyAttentionKilocodeEvent(data: unknown): AttentionEvent | null {
  if (typeof data !== 'object' || data === null) return null;
  const dataRecord = data as Record<string, unknown>;
  const eventName = typeof dataRecord.event === 'string' ? dataRecord.event : undefined;
  if (!eventName) return null;

  const raiseReason = RAISE_KILO_EVENTS.get(eventName);
  const resolveReason = RESOLVE_KILO_EVENTS.get(eventName);
  if (raiseReason === undefined && resolveReason === undefined) return null;

  const intent: AttentionIntent =
    raiseReason !== undefined
      ? { raise: raiseReason }
      : { resolve: resolveReason as 'question' | 'permission' };
  const isResolve = resolveReason !== undefined;

  const properties =
    typeof dataRecord.properties === 'object' && dataRecord.properties !== null
      ? (dataRecord.properties as Record<string, unknown>)
      : null;

  // Authoritative nested id; top-level fallback for the wrapper's
  // real-time spread shape. Resolves use requestID only — the upstream
  // contract guarantees `properties.requestID` and never the legacy `id`,
  // and the wrapper spreads `properties` at the top level so the fallback
  // still resolves to the same value. Raises use `id`.
  let requestId: string | undefined;
  if (isResolve) {
    requestId =
      readNonEmptyString(properties, 'requestID') ?? readNonEmptyString(dataRecord, 'requestID');
  } else {
    requestId = readNonEmptyString(properties, 'id') ?? readNonEmptyString(dataRecord, 'id');
  }
  if (!requestId) return null;

  const sourceKiloSessionId =
    readSessionIdFromRecord(properties) ?? readSessionIdFromRecord(dataRecord);
  if (!sourceKiloSessionId) return null;

  return { requestId, intent, sourceKiloSessionId };
}
