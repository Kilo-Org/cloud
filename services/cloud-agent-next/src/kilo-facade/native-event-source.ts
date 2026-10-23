import type { StreamEvent } from '../websocket/types.js';
import {
  projectPublicStructuredPaths,
  publicCloudAgentDirectory,
} from './public-sdk-projection.js';

/**
 * Native event delivery for a hosted `workspace_*` session (spec §10).
 *
 * The control-plane Session DO already receives every wrapper event, persists
 * it, and broadcasts it on its own `/stream`. There is no wrapper-to-facade
 * feed on that plane, and a Durable Object cannot open a WebSocket to another
 * Durable Object, so the Session DO pushes bounded sequence-fenced batches to
 * the per-user facade, which phases that live tail with the durable log snapshot it
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

/** Large events extend the payload backlog, not the per-event or count limits. */
export const NATIVE_DELIVERY_LIMITS = {
  count: 512,
  bytes: 64 * 1024,
  eventBytes: 256 * 1024,
  retainedBytes: (64 + 256) * 1024,
  batchBytes: (64 + 256 + 4) * 1024,
  ageMs: 2_000,
  coalesceMs: 10,
} as const;
export const MAX_PENDING_NATIVE_EVENTS = NATIVE_DELIVERY_LIMITS.count;

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

/** One persisted event pushed by the Session DO to the facade. */
export type NativeEventDelivery = {
  cloudAgentSessionId: string;
  kiloSessionId: string;
  eventId: number;
  materialized?: boolean;
  event: NativePublicEvent;
};

export type NativeEventContinuity = { generation: number; sequence: number };
export type NativeEventSubscription = {
  registered: boolean;
  fence: number | null;
  kiloSessionId: string;
  continuity: NativeEventContinuity;
};
export type NativeEventBatch = {
  kiloUserId: string;
  cloudAgentSessionId: string;
  kiloSessionId: string;
  generation: number;
} & (
  | {
      kind: 'events';
      firstSequence: number;
      events: Omit<NativeEventDelivery, 'cloudAgentSessionId' | 'kiloSessionId'>[];
    }
  | { kind: 'loss'; attachmentIds: string[] }
);

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

export type NativeAttachmentState = {
  cloudAgentSessionId: string;
  kiloSessionId: string;
  fence: number | null;
  phase: 'snapshot' | 'live' | 'lost';
  /** Pushed events held until the snapshot through the fence is delivered. */
  pending: { delivery: NativeEventDelivery; continuity?: NativeEventContinuity }[];
  pendingBytes: number;
  continuity?: NativeEventContinuity;
  listeners: Set<(event: NativePublicEvent) => void>;
};

export type NativeAttachmentRegistry = {
  begin(cloudAgentSessionId: string, kiloSessionId: string, attachmentId?: string): void;
  complete(cloudAgentSessionId: string, fence: number | null): void;
  deliver(delivery: NativeEventDelivery): void;
  bind(attachmentId: string, continuity: NativeEventContinuity): void;
  deliverBatch(batch: NativeEventBatch, attachmentIds: string[]): void;
  invalidate(attachmentId: string): void;
  generation(attachmentId: string): number | undefined;
  isLost(attachmentId: string): boolean;
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
    if (state.phase === 'lost') return;
    state.phase = 'lost';
    state.pending = [];
    state.pendingBytes = 0;
    onOverflow(attachmentId, state.kiloSessionId);
  }

  function emit(state: NativeAttachmentState, event: NativePublicEvent): void {
    for (const listener of state.listeners) listener(event);
  }

  function deliver(
    attachmentId: string,
    state: NativeAttachmentState,
    delivery: NativeEventDelivery,
    continuity?: NativeEventContinuity
  ) {
    if (state.phase === 'lost') return;
    if (continuity !== undefined && state.continuity !== undefined) {
      if (continuity.generation !== state.continuity.generation) {
        if (continuity.generation > state.continuity.generation) fail(attachmentId, state);
        return;
      }
      if (continuity.sequence <= state.continuity.sequence) return;
      if (continuity.sequence !== state.continuity.sequence + 1) {
        fail(attachmentId, state);
        return;
      }
      state.continuity = continuity;
    }
    if (delivery.eventId === 0 && state.phase === 'snapshot' && state.continuity !== undefined) {
      fail(attachmentId, state);
      return;
    }
    if (
      delivery.eventId > 0 &&
      !delivery.materialized &&
      state.fence !== null &&
      delivery.eventId <= state.fence
    )
      return;
    const bytes = new TextEncoder().encode(JSON.stringify(delivery.event)).byteLength;
    if (bytes > NATIVE_DELIVERY_LIMITS.eventBytes) {
      fail(attachmentId, state);
      return;
    }
    if (
      state.phase === 'snapshot' ||
      (continuity !== undefined && state.continuity === undefined)
    ) {
      if (!canRetainNativeEvent(state.pending.length, state.pendingBytes, bytes)) {
        fail(attachmentId, state);
        return;
      }
      state.pending.push({
        delivery,
        continuity: state.continuity === undefined ? continuity : undefined,
      });
      state.pendingBytes += bytes;
      return;
    }
    emit(state, delivery.event);
  }

  return {
    begin(cloudAgentSessionId, kiloSessionId, attachmentId = cloudAgentSessionId) {
      const existing = attachments.get(attachmentId);
      if (existing !== undefined) {
        existing.kiloSessionId = kiloSessionId;
        existing.fence = null;
        existing.phase = 'snapshot';
        existing.pending = [];
        existing.pendingBytes = 0;
        existing.continuity = undefined;
        return;
      }
      attachments.set(attachmentId, {
        cloudAgentSessionId,
        kiloSessionId,
        fence: null,
        phase: 'snapshot',
        pending: [],
        pendingBytes: 0,
        listeners: new Set(),
      });
    },
    complete(cloudAgentSessionId, fence) {
      const state = attachments.get(cloudAgentSessionId);
      if (state === undefined) return;
      state.fence = fence;
      if (state.phase === 'lost') return;
      state.phase = 'live';
      const pending = state.pending;
      state.pending = [];
      state.pendingBytes = 0;
      for (const { delivery } of pending) {
        if (
          delivery.eventId > 0 &&
          !delivery.materialized &&
          fence !== null &&
          delivery.eventId <= fence
        )
          continue;
        emit(state, delivery.event);
      }
    },
    deliver(delivery) {
      for (const [attachmentId, state] of attachments) {
        if (state.cloudAgentSessionId !== delivery.cloudAgentSessionId || state.phase === 'lost')
          continue;
        if (state.kiloSessionId !== delivery.kiloSessionId) continue;
        deliver(attachmentId, state, delivery);
      }
    },
    bind(attachmentId, continuity) {
      const state = attachments.get(attachmentId);
      if (state === undefined || state.phase === 'lost') return;
      if (state.continuity !== undefined) {
        if (state.continuity.generation !== continuity.generation) fail(attachmentId, state);
        return;
      }
      state.continuity = continuity;
      const pending = state.pending;
      state.pending = [];
      state.pendingBytes = 0;
      for (const entry of pending) deliver(attachmentId, state, entry.delivery, entry.continuity);
    },
    deliverBatch(batch, attachmentIds) {
      for (const attachmentId of attachmentIds) {
        const state = attachments.get(attachmentId);
        if (
          state === undefined ||
          state.cloudAgentSessionId !== batch.cloudAgentSessionId ||
          state.kiloSessionId !== batch.kiloSessionId
        )
          continue;
        if (batch.kind === 'loss') {
          if (state.continuity !== undefined && batch.generation < state.continuity.generation)
            continue;
          if (batch.attachmentIds.includes(attachmentId)) fail(attachmentId, state);
          continue;
        }
        for (const [index, event] of batch.events.entries()) {
          deliver(
            attachmentId,
            state,
            {
              ...event,
              cloudAgentSessionId: batch.cloudAgentSessionId,
              kiloSessionId: batch.kiloSessionId,
            },
            { generation: batch.generation, sequence: batch.firstSequence + index }
          );
        }
      }
    },
    invalidate(attachmentId) {
      const state = attachments.get(attachmentId);
      if (state !== undefined) fail(attachmentId, state);
    },
    generation(attachmentId) {
      return attachments.get(attachmentId)?.continuity?.generation;
    },
    isLost(attachmentId) {
      return attachments.get(attachmentId)?.phase === 'lost';
    },
    subscribe(cloudAgentSessionId, listener) {
      const state = attachments.get(cloudAgentSessionId);
      if (state === undefined) return () => undefined;
      if (state.phase === 'lost') {
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
