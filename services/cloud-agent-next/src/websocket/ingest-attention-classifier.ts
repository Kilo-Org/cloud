/**
 * Attention event classifier for kilocode ingest events.
 *
 * Cloud agent session attention is raise-only: `question.asked` and
 * `permission.asked` indicate the wrapper is waiting for human input and
 * should trigger a best-effort push notification. Resolves are not
 * consumed (no outbox or scheduler) so they intentionally return `null`.
 *
 * The classifier is pure and synchronous, returning a stable requestId,
 * a raise kind, and the source `kiloSessionId` so the caller can filter
 * out events from child/sub-agent kilocode sessions of this Cloud Agent
 * run, or null for non-attention events.
 *
 * Authoritative id source for raises: `properties.id`, with top-level
 * `data.id` as the fallback (the wrapper's real-time shape spreads
 * properties at the top level of `data`).
 *
 * The source `kiloSessionId` is extracted from `properties.sessionID`
 * (authoritative) or top-level `data.sessionID` (fallback). A qualifying
 * event without a non-empty source `sessionID` is ignored because the
 * caller cannot verify it belongs to the root session.
 */

import type { SessionMetadata } from '../persistence/session-metadata.js';
import type { SendCloudAgentSessionNotificationParams } from '../notifications-binding.js';

export type AttentionEvent = {
  requestId: string;
  kind: 'question' | 'permission';
  sourceKiloSessionId: string;
};

/**
 * The subset of `SessionMetadata` needed by the attention push gate.
 * Kept narrow so the dispatch function can be called from the Durable
 * Object (full `SessionMetadata`) and from unit tests (synthetic fixtures)
 * without coupling tests to unrelated metadata fields.
 */
export type CloudAgentAttentionMetadata = Pick<SessionMetadata, 'auth' | 'identity'>;

/**
 * Dependencies the dispatch function needs from its host. The Durable
 * Object supplies these; unit tests inject spies.
 */
export type AttentionPushDeps = {
  hasConnectedStreamClients: () => boolean;
  sendPush: (params: SendCloudAgentSessionNotificationParams) => Promise<unknown>;
};

const RAISE_KILO_EVENTS: ReadonlyMap<string, 'question' | 'permission'> = new Map([
  ['question.asked', 'question'],
  ['permission.asked', 'permission'],
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
 * Returns a stable requestId and raise kind, or null when the event is
 * not an attention raise. The wrapper's real-time shape spreads
 * properties at the top level of `data`, so the id is read from the
 * nested `properties` first and falls back to the top-level field.
 *
 * @param data - The kilocode event data (already validated as an object)
 * @returns AttentionEvent with requestId, kind, and sourceKiloSessionId, or null
 */
export function classifyAttentionKilocodeEvent(data: unknown): AttentionEvent | null {
  if (typeof data !== 'object' || data === null) return null;
  const dataRecord = data as Record<string, unknown>;
  const eventName = typeof dataRecord.event === 'string' ? dataRecord.event : undefined;
  if (!eventName) return null;

  const kind = RAISE_KILO_EVENTS.get(eventName);
  if (kind === undefined) return null;

  const properties =
    typeof dataRecord.properties === 'object' && dataRecord.properties !== null
      ? (dataRecord.properties as Record<string, unknown>)
      : null;

  // Authoritative nested id; top-level fallback for the wrapper's
  // real-time spread shape.
  const requestId = readNonEmptyString(properties, 'id') ?? readNonEmptyString(dataRecord, 'id');
  if (!requestId) return null;

  const sourceKiloSessionId =
    readSessionIdFromRecord(properties) ?? readSessionIdFromRecord(dataRecord);
  if (!sourceKiloSessionId) return null;

  return { requestId, kind, sourceKiloSessionId };
}

/**
 * Gate + dispatch a best-effort push notification for a root-session
 * `question.asked`/`permission.asked` event. Mirrors the terminal push
 * gates used by the message settlement outbox.
 *
 * Gate order (each step short-circuits with `'suppressed'`):
 *   1. metadata must be present
 *   2. event's source `kiloSessionId` must equal the run's root
 *      `auth.kiloSessionId` (filters child/sub-agent sessions)
 *   3. `identity.createdOnPlatform` must be `'cloud-agent-web'`
 *   4. `auth.kiloSessionId` must be present (defensive; subsumed by
 *      step 2 today but explicit for future callers)
 *   5. no `/stream` clients may currently be connected
 *
 * On the happy path, calls `deps.sendPush` with the stable
 * `executionId: 'attention:' + event.requestId` and returns `'sent'`.
 * The executionId is the dedup key the notifications service uses to
 * drop replays for the same raise.
 *
 * This function is intentionally free of try/catch: any error from
 * `deps.sendPush` propagates to the caller (the Durable Object's
 * `handleAttentionEvent`), which logs with DO-specific context and
 * swallows so the ingest path stays non-blocking.
 */
export async function dispatchCloudAgentAttentionPush(
  event: AttentionEvent,
  metadata: CloudAgentAttentionMetadata | null,
  deps: AttentionPushDeps
): Promise<'sent' | 'suppressed'> {
  if (!metadata) return 'suppressed';

  const cliSessionId = metadata.auth.kiloSessionId;
  if (event.sourceKiloSessionId !== cliSessionId) return 'suppressed';
  if (metadata.identity.createdOnPlatform !== 'cloud-agent-web') return 'suppressed';
  if (!cliSessionId) return 'suppressed';
  if (deps.hasConnectedStreamClients()) return 'suppressed';

  await deps.sendPush({
    userId: metadata.identity.userId,
    cliSessionId,
    executionId: `attention:${event.requestId}`,
    status: 'completed',
    category: 'attention',
    body: 'Kilo needs your input.',
    suppressIfViewingSession: true,
  });

  return 'sent';
}
