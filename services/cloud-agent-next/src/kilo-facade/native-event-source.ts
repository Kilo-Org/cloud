import type { StreamEvent } from '../websocket/types.js';
import { publicCloudAgentDirectory } from './public-sdk-projection.js';

/**
 * Native event delivery for a hosted `workspace_*` session (spec §10).
 *
 * The control-plane Session DO already receives every wrapper event, persists
 * it, and broadcasts it on its own `/stream`. There is no wrapper-to-facade
 * feed on that plane, and a Durable Object cannot open a WebSocket to another
 * Durable Object, so the Session DO pushes each stored event to the per-user
 * facade and the facade phases that live tail with the durable log snapshot it
 * fetches for the same attachment.
 *
 * The history/live boundary is the attach fence: the snapshot (stored log plus
 * materialized message/part reconciliation) is complete through the fence, and
 * pushed events are delivered after it. Materialized rewrites retain their row
 * IDs and must replay even below the fence. When continuity cannot be
 * proven (a dropped push, overflow, or transport gap) the facade reports
 * `resnapshot-required` and the client rebuilds its transcript and pending
 * interactions before more input is admitted.
 */

/** Bound on pushed events retained per attachment while its snapshot is in flight. */
export const MAX_PENDING_NATIVE_EVENTS = 512;

export const NATIVE_FACADE_RESNAPSHOT_EVENT = 'kilo.native.resnapshot';
export const NATIVE_FACADE_FENCE_EVENT = 'kilo.native.fence';

/**
 * Rows whose stored id can stay below a cursor while their content changes
 * (entity upserts keep the row id) or that can disappear. A client replaying
 * from the fence misses them, so the snapshot replays these materialized rows
 * whole, exactly like the existing `/stream` reconciliation.
 */
export const NATIVE_MATERIALIZED_EVENT_TYPES = [
  'message.updated',
  'message.part.updated',
  'message.removed',
  'message.part.removed',
] as const;

/** Native Kilo event payload in the public directory namespace. */
export type NativePublicEvent = {
  type: string;
  properties: Record<string, unknown>;
};

/** One persisted event pushed by the Session DO to the facade. */
export type NativeEventDelivery = {
  cloudAgentSessionId: string;
  kiloSessionId: string;
  eventId: number;
  materialized?: boolean;
  event: NativePublicEvent;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `message.updated` / `message.part.updated` / removals only. */
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
export function isDeliverableNativeEvent(event: StreamEvent): boolean {
  if (event.eventId === 0) return false;
  return event.streamEventType === 'kilocode' || event.streamEventType.startsWith('cloud.');
}

/** Translates one stored stream envelope into a native Kilo event payload. */
export function toNativePublicEvent(
  event: Pick<StreamEvent, 'data'>,
  kiloSessionId: string
): NativePublicEvent | null {
  const directory = publicCloudAgentDirectory(kiloSessionId);
  if (!isRecord(event.data)) return null;
  // Preparation progress rows carry the reported native event verbatim.
  if (typeof event.data.event === 'string' && isRecord(event.data.properties)) {
    const properties = event.data.properties;
    if (properties.sessionID !== undefined && properties.sessionID !== kiloSessionId) return null;
    return {
      type: event.data.event,
      properties: { ...properties, sessionID: kiloSessionId, directory },
    };
  }
  if (typeof event.data.type !== 'string') return null;
  const payload = isRecord(event.data.properties) ? event.data.properties : event.data;
  return {
    type: event.data.type,
    properties: {
      ...payload,
      sessionID: kiloSessionId,
      directory,
    },
  };
}

export type NativeAttachmentState = {
  cloudAgentSessionId: string;
  kiloSessionId: string;
  fence: number | null;
  snapshotPending: boolean;
  /** Pushed events held until the snapshot through the fence is delivered. */
  pending: NativeEventDelivery[];
  listeners: Set<(event: NativePublicEvent) => void>;
  overflowed: boolean;
};

export type NativeAttachmentRegistry = {
  begin(cloudAgentSessionId: string, kiloSessionId: string, attachmentId?: string): void;
  complete(cloudAgentSessionId: string, fence: number | null): void;
  deliver(delivery: NativeEventDelivery): void;
  subscribe(cloudAgentSessionId: string, listener: (event: NativePublicEvent) => void): () => void;
  release(cloudAgentSessionId: string): void;
};

/**
 * Holds pushed events per attachment while its snapshot is in flight. A push
 * that arrives before `complete` is buffered; once the snapshot through the
 * fence is delivered the buffer drains in order. Only immutable pushes at or
 * below the fence are covered by the snapshot. Exceeding the buffer ends in a
 * `resnapshot` notice, because the client must rebuild rather than guess.
 */
export function createNativeAttachmentRegistry(
  onOverflow: (attachmentId: string, kiloSessionId: string) => void
): NativeAttachmentRegistry {
  const attachments = new Map<string, NativeAttachmentState>();

  function fail(attachmentId: string, state: NativeAttachmentState): void {
    state.overflowed = true;
    state.pending = [];
    onOverflow(attachmentId, state.kiloSessionId);
  }

  function emit(state: NativeAttachmentState, event: NativePublicEvent): void {
    for (const listener of state.listeners) listener(event);
  }

  return {
    begin(cloudAgentSessionId, kiloSessionId, attachmentId = cloudAgentSessionId) {
      const existing = attachments.get(attachmentId);
      if (existing !== undefined) {
        existing.kiloSessionId = kiloSessionId;
        existing.fence = null;
        existing.snapshotPending = true;
        existing.pending = [];
        existing.overflowed = false;
        return;
      }
      attachments.set(attachmentId, {
        cloudAgentSessionId,
        kiloSessionId,
        fence: null,
        snapshotPending: true,
        pending: [],
        listeners: new Set(),
        overflowed: false,
      });
    },
    complete(cloudAgentSessionId, fence) {
      const state = attachments.get(cloudAgentSessionId);
      if (state === undefined) return;
      state.fence = fence;
      state.snapshotPending = false;
      if (state.overflowed) return;
      const pending = state.pending;
      state.pending = [];
      for (const delivery of pending) {
        if (!delivery.materialized && fence !== null && delivery.eventId <= fence) continue;
        emit(state, delivery.event);
      }
    },
    deliver(delivery) {
      for (const [attachmentId, state] of attachments) {
        if (state.cloudAgentSessionId !== delivery.cloudAgentSessionId || state.overflowed)
          continue;
        if (state.kiloSessionId !== delivery.kiloSessionId) continue;
        if (!delivery.materialized && state.fence !== null && delivery.eventId <= state.fence)
          continue;
        if (state.snapshotPending) {
          if (state.pending.length >= MAX_PENDING_NATIVE_EVENTS) {
            fail(attachmentId, state);
            continue;
          }
          state.pending.push(delivery);
          continue;
        }
        emit(state, delivery.event);
      }
    },
    subscribe(cloudAgentSessionId, listener) {
      const state = attachments.get(cloudAgentSessionId);
      if (state === undefined) return () => undefined;
      if (state.overflowed) {
        listener({
          type: NATIVE_FACADE_RESNAPSHOT_EVENT,
          properties: {
            sessionID: state.kiloSessionId,
            directory: publicCloudAgentDirectory(state.kiloSessionId),
            reason: 'continuity_unproven',
          },
        });
        return () => undefined;
      }
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },
    release(cloudAgentSessionId) {
      attachments.delete(cloudAgentSessionId);
    },
  };
}
