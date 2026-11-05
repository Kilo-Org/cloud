import type { SessionStatus } from '../shared/protocol.js';
import type { StreamEvent } from '../websocket/types.js';
import { projectPublicCloudAgentExtensionEvent } from './cloud-agent-extension-events.js';
import {
  projectPublicStructuredPaths,
  publicCloudAgentDirectory,
} from './public-sdk-projection.js';

/**
 * Native event delivery for a hosted `workspace_*` session (spec §10).
 *
 * The control-plane Session DO persists every wrapper event and broadcasts it
 * on its hibernatable `/stream` socket. A Durable Object uses a WebSocket as a
 * client to another Durable Object, so the per-user facade opens that socket
 * directly (see `native-event-tail.ts`) and tails it after the fenced snapshot.
 * The durable log is the only cursor: the tail reports `resnapshot-required`
 * only when continuity cannot be proven, and the client rebuilds its transcript
 * and pending interactions before more input is admitted.
 *
 * This module owns the shared event projection and the delivery bounds.
 */

/** Large events extend the payload backlog, not the per-event or count limits. */
export const NATIVE_DELIVERY_LIMITS = {
  count: 512,
  bytes: 64 * 1024,
  eventBytes: 256 * 1024,
  retainedBytes: (64 + 256) * 1024,
  batchBytes: (64 + 256 + 4) * 1024,
  coalesceMs: 10,
} as const;

export function canRetainNativeEvent(count: number, retainedBytes: number, eventBytes: number) {
  const byteBudget =
    retainedBytes > NATIVE_DELIVERY_LIMITS.bytes || eventBytes > NATIVE_DELIVERY_LIMITS.bytes
      ? NATIVE_DELIVERY_LIMITS.retainedBytes
      : NATIVE_DELIVERY_LIMITS.bytes;
  return (
    count < NATIVE_DELIVERY_LIMITS.count &&
    eventBytes <= NATIVE_DELIVERY_LIMITS.eventBytes &&
    retainedBytes + eventBytes <= byteBudget
  );
}

export const NATIVE_FACADE_RESNAPSHOT_EVENT = 'kilo.native.resnapshot';
export const NATIVE_FACADE_FENCE_EVENT = 'kilo.native.fence';

/**
 * Rows whose stored id can stay below a cursor while their content changes
 * (entity upserts keep the row id) or that can disappear. A client replaying
 * from the fence misses them, so the snapshot replays these materialized rows
 * whole, exactly like the existing `/stream` reconciliation.
 */
export const NATIVE_MATERIALIZED_EVENT_TYPES = [
  'session.created',
  'session.updated',
  'session.status',
  'conversation.source',
  'conversation.message.updated',
  'message.updated',
  'message.part.updated',
  'message.removed',
  'message.part.removed',
  'autocommit_completed',
] as const;

/** Native Kilo event payload in the public directory namespace. */
export type NativePublicEvent = {
  type: string;
  properties: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isMaterializedNativeEvent(event: StreamEvent): boolean {
  if (event.streamEventType !== 'kilocode' || !isRecord(event.data)) return false;
  return (NATIVE_MATERIALIZED_EVENT_TYPES as readonly string[]).includes(
    String(event.data.event ?? event.data.type)
  );
}

/**
 * Interior frames are not transcript content. `cloud.*` rows are terminal
 * message outcomes and Cloud status, which the native client renders as
 * completion/interruption/status updates beside the native events.
 */
export function isDeliverableNativeEvent(event: StreamEvent, live = false): boolean {
  if (event.eventId === 0)
    return (
      live &&
      event.streamEventType === 'kilocode' &&
      isRecord(event.data) &&
      (event.data.event ?? event.data.type) === 'message.part.delta'
    );
  return event.streamEventType === 'kilocode' || event.streamEventType.startsWith('cloud.');
}

/** Translates one stored stream envelope into a native Kilo event payload. */
export function toNativePublicEvent(
  event: Pick<StreamEvent, 'data'> & { streamEventType?: StreamEvent['streamEventType'] },
  kiloSessionId: string
): NativePublicEvent | null {
  const directory = publicCloudAgentDirectory(kiloSessionId);
  // Cloud terminal rows carry their identity in the stream event type, not in
  // the payload. Project them through the existing public extension contract so
  // a stored `cloud.message.completed`/`failed` row remains replayable.
  if (event.streamEventType?.startsWith('cloud.')) {
    const projected = projectPublicCloudAgentExtensionEvent(
      {
        stream_event_type: event.streamEventType,
        payload: JSON.stringify(event.data) ?? 'null',
      },
      kiloSessionId
    );
    if (projected === null) return null;
    return {
      type: projected.type,
      properties: { ...projected.properties, directory },
    };
  }
  if (!isRecord(event.data)) return null;
  // Preparation progress rows carry the reported native event verbatim.
  if (typeof event.data.event === 'string' && isRecord(event.data.properties)) {
    const properties = event.data.properties;
    if (properties.sessionID !== undefined && properties.sessionID !== kiloSessionId) return null;
    return {
      type: event.data.event,
      properties: {
        ...projectPublicStructuredPaths(properties, kiloSessionId),
        sessionID: kiloSessionId,
        directory,
      },
    };
  }
  if (typeof event.data.type !== 'string') return null;
  const payload = isRecord(event.data.properties) ? event.data.properties : event.data;
  return {
    type: event.data.type,
    properties: {
      ...projectPublicStructuredPaths(payload, kiloSessionId),
      sessionID: kiloSessionId,
      directory,
    },
  };
}

/**
 * The Session DO's authoritative view of a native snapshot. The stored log can
 * end on a stale `busy` status or a pending prompt whose resolution was never
 * persisted, so reconnects emit these corrections after replay and before the
 * fence.
 */
export type NativeSnapshotAuthority = {
  sessionStatus?: SessionStatus;
  questions?: readonly unknown[];
  permissions?: readonly unknown[];
};

function interactionId(value: unknown): string | undefined {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0
    ? value.id
    : undefined;
}

function replyRequestId(event: NativePublicEvent): string | undefined {
  return typeof event.properties.requestID === 'string' && event.properties.requestID.length > 0
    ? event.properties.requestID
    : undefined;
}

/**
 * Tracks the interactions a snapshot replay leaves open, then emits the
 * authoritative corrections at the end of that replay:
 *
 * - the derived session status, so a stale replayed `busy` cannot survive;
 * - an ask for every interaction the Session DO still reports as pending;
 * - a resolution for every replayed ask the Session DO no longer reports.
 *
 * The reconcile runs before the fence, while live pushes remain buffered, so a
 * newer live busy/ask always wins over an older snapshot correction.
 */
export function createNativeSnapshotReconciler(kiloSessionId: string) {
  const openQuestions = new Set<string>();
  const openPermissions = new Set<string>();

  const project = (type: string, properties: Record<string, unknown>) =>
    toNativePublicEvent({ data: { event: type, properties } }, kiloSessionId);

  return {
    observe(event: NativePublicEvent): void {
      if (event.type === 'question.asked' || event.type === 'permission.asked') {
        const id = interactionId(event.properties);
        if (id !== undefined) {
          (event.type === 'question.asked' ? openQuestions : openPermissions).add(id);
        }
        return;
      }
      const id = replyRequestId(event);
      if (id === undefined) return;
      if (event.type === 'question.replied' || event.type === 'question.rejected') {
        openQuestions.delete(id);
      } else if (event.type === 'permission.replied') {
        openPermissions.delete(id);
      }
    },

    corrections(authority: NativeSnapshotAuthority): NativePublicEvent[] {
      const corrections: NativePublicEvent[] = [];
      if (authority.sessionStatus !== undefined) {
        const status = project('session.status', {
          sessionID: kiloSessionId,
          status: authority.sessionStatus,
        });
        if (status !== null) corrections.push(status);
      }
      const reconcileCollection = (
        items: readonly unknown[] | undefined,
        open: ReadonlySet<string>,
        askedType: string,
        resolvedType: string
      ): void => {
        if (items === undefined) return;
        const pending = new Set<string>();
        for (const item of items) {
          const id = interactionId(item);
          if (id === undefined) continue;
          pending.add(id);
          const asked = project(askedType, isRecord(item) ? item : {});
          if (asked !== null) corrections.push(asked);
        }
        for (const id of open) {
          if (pending.has(id)) continue;
          const resolved = project(resolvedType, {
            sessionID: kiloSessionId,
            requestID: id,
          });
          if (resolved !== null) corrections.push(resolved);
        }
      };
      reconcileCollection(
        authority.questions,
        openQuestions,
        'question.asked',
        'question.rejected'
      );
      reconcileCollection(
        authority.permissions,
        openPermissions,
        'permission.asked',
        'permission.replied'
      );
      return corrections;
    },
  };
}
