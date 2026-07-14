/**
 * Pure classification and backoff helpers for the per-session attention outbox.
 *
 * Decoupled from drizzle and the DO surface so the rules are cheap to unit-test
 * and easy to reason about. The DO reads envelope data through
 * `extractAttentionRequest` (also pure) and feeds the resulting pieces to
 * `classifyAttentionEvent` and `isActionable` / `isResolvedEvent`.
 *
 * The outbox records a single row per stable upstream request id, so:
 * - Duplicate replays of the same `*.asked` event collapse (no-op).
 * - A `rejected`/`replied`/etc. on a never-raised id is a no-op too.
 * - Resolving an already-resolved request is a no-op.
 * - Re-raising an already-resolved request is a no-op.
 * Distinct requests stay independent.
 *
 * Stable request id sources by reason:
 * - `question.asked` / `question.replied` / `question.rejected` → envelope id
 *   (raw property `id` or `requestId`, mapped by the DO).
 * - `permission.asked` / `permission.replied` → envelope id.
 * - `suggestion.shown` / `suggestion.accepted` / `suggestion.dismissed` →
 *   envelope id; raise only when `blocking` is the boolean `true`. String
 *   or numeric truthy values are ignored because the upstream typed
 *   contract is boolean.
 *
 * Events that look actionable to a human but do not currently expose a
 * stable request id, or are non-actionable transport noise, are ignored
 * outright so we never push on a request we can't reconcile with a
 * subsequent resolve/replay.
 */

import { z } from 'zod';

export const attentionReasonSchema = z.enum(['question', 'permission', 'blocking_suggestion']);
export type AttentionReason = z.infer<typeof attentionReasonSchema>;

export type AttentionIntent =
  | { kind: 'raise'; reason: AttentionReason }
  | { kind: 'resolve'; reason: null };

export const MAX_ATTEMPTS = 7;

/**
 * Map a raw event name + envelope data to a raise/resolve intent. Returns
 * null when the event is out of scope for human-attention pushes (network
 * waits, automatic retries, status pings, message metadata, etc.).
 *
 * `data` is treated as an opaque object — producers may pass either
 * `raw.properties` from the kilocode wrapper payload or the inner body
 * of a `cloud_agent` envelope; the classifier only reads the fields it
 * needs (`id`, `requestId`, `blocking`).
 */
export function classifyAttentionEvent(eventName: string, data: unknown): AttentionIntent | null {
  const props = readRecord(data);

  switch (eventName) {
    case 'question.asked':
      return { kind: 'raise', reason: 'question' };
    case 'question.replied':
    case 'question.rejected':
      return { kind: 'resolve', reason: null };

    case 'permission.asked':
      return { kind: 'raise', reason: 'permission' };
    case 'permission.replied':
      return { kind: 'resolve', reason: null };

    case 'suggestion.shown':
      // Only blocking suggestions are user-actionable. Non-blocking
      // suggestions are advisory and would spam the lock screen.
      return props?.blocking === true ? { kind: 'raise', reason: 'blocking_suggestion' } : null;
    case 'suggestion.accepted':
    case 'suggestion.dismissed':
      return { kind: 'resolve', reason: null };

    default:
      return null;
  }
}

export function isActionable(intent: AttentionIntent): boolean {
  return intent.kind === 'raise';
}

export function isResolvedEvent(intent: AttentionIntent): boolean {
  return intent.kind === 'resolve';
}

/**
 * Compute the next attempt timestamp. `attemptCount` is the number of
 * attempts that have already been made (0 before the first try).
 *
 * Attempts are numbered 0 through 6. Once a caller has made attempt 6 and
 * still needs to retry, the row is parked at the terminal `failed` status
 * (attempt 7 is terminal), so this helper is never asked to schedule
 * attempt 7 or beyond. The clamped return value here is a defensive safety
 * net only.
 *
 * Backoff sequence (ms after `now`):
 *   attempt 0 → 0
 *   attempt 1 → 5_000
 *   attempt 2 → 15_000
 *   attempt 3 → 60_000
 *   attempt 4 → 300_000
 *   attempt 5 → 900_000
 *   attempt 6 → 3_600_000 (capped)
 *
 * The intent is to push immediately on first raise (the user just
 * reached a wait state), then back off aggressively so retries don't
 * pile up during long-lived waits.
 */
export function computeNextAttemptAt(attemptCount: number, now: number): number {
  const schedule = [0, 5_000, 15_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
  const idx = Math.min(Math.max(attemptCount, 0), schedule.length - 1);
  return now + (schedule[idx] ?? 0);
}

/**
 * Read a stable request id from the raw envelope. Looks at the fields the
 * upstream producers actually use (`id` on kilocode payloads,
 * `requestId`/`requestID` on cloud-agent envelopes) and returns the
 * first non-empty string found, or null when the envelope is missing
 * the id. The DO layer never logs the id value — it only forwards it
 * to the outbox and notifications service.
 */
export function extractRequestId(data: unknown): string | null {
  return extractStableRequestId(data);
}

/**
 * Read a stable request id from a remote CLI event envelope.
 *
 * Authoritative shape: the kilocode CLI producer forwards
 * `{ type: 'event', data: event.properties }` (the event's properties are
 * the envelope), so the id lives at the top level of `data`
 * (`data.id`, or `data.requestId` / `data.requestID`).
 *
 * Compatibility shape: the cloud-agent-next wrapper sends
 * `{ ...properties, event, type, properties }` and therefore exposes the id
 * at both the top level and under `data.properties`. We read the top-level
 * first and only fall back to `data.properties` when the top level is
 * missing the field, so the two shapes are interchangeable.
 *
 * Returns the first non-empty string value, or null when the envelope
 * does not carry a usable id. The DO layer never logs the id value.
 */
export function extractStableRequestId(data: unknown): string | null {
  const id = readIdFromRecord(data);
  if (id !== null) return id;
  const props = readRecord(data);
  if (!props) return null;
  const nested = readRecord(props.properties);
  if (!nested) return null;
  return readIdFromRecord(nested);
}

function readIdFromRecord(data: unknown): string | null {
  const props = readRecord(data);
  if (!props) return null;
  for (const key of ['requestId', 'requestID', 'id']) {
    const value = props[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * Resolve a remote CLI event into an attention signal suitable for the
 * per-session outbox. Returns `null` when the event is out of scope, the
 * envelope is malformed, or the event has no stable request id (we
 * never push on a request we can't reconcile with a later resolve).
 *
 * Pure helper: callers pass the raw `event` name and the `data` envelope
 * exactly as the CLI delivered them. The helper reads the id from the
 * authoritative direct shape with a nested `properties` fallback for
 * producers that wrap the body (see `extractStableRequestId`).
 */
export function extractAttentionSignal(
  event: string,
  data: unknown
): {
  intent: AttentionIntent;
  requestId: string;
} | null {
  const intent = classifyAttentionEvent(event, data);
  if (intent === null) return null;
  const requestId = extractStableRequestId(data);
  if (requestId === null) return null;
  return { intent, requestId };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
