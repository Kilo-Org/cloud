import type {
  NativeEventDelivery,
  NativeEventBatch,
} from '../../kilo-facade/native-event-source.js';
import {
  canRetainNativeEvent,
  NATIVE_DELIVERY_LIMITS,
} from '../../kilo-facade/native-event-source.js';

type Event = Omit<NativeEventDelivery, 'cloudAgentSessionId' | 'kiloSessionId'>;
type Entry = { event: Event; sequence: number; bytes: number; deadlineAt: number };

export function createNativeEventOutbox(options: {
  identity: () => { kiloUserId: string; cloudAgentSessionId: string; kiloSessionId: string } | null;
  generation: () => number;
  send: (batch: NativeEventBatch, deadlineAt: number) => Promise<void>;
  waitUntil: (work: Promise<void>) => void;
  diagnostic: (reason: string) => void;
}) {
  const subscriptions = new Map<string, 'active' | 'lost'>();
  const pending: Entry[] = [];
  const losses = new Set<string>();
  let sequence = 0;
  const retained = new Set<Entry>();
  let retainedBytes = 0;
  let scheduled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelDelay: (() => void) | undefined;
  const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

  function lose(attachmentIds: string[], reason: string) {
    for (const attachmentId of attachmentIds) {
      if (subscriptions.get(attachmentId) !== 'active') continue;
      subscriptions.set(attachmentId, 'lost');
      losses.add(attachmentId);
    }
    options.diagnostic(reason);
  }

  function discardPending() {
    for (const entry of pending) {
      if (retained.delete(entry)) retainedBytes -= entry.bytes;
    }
    pending.length = 0;
  }

  function activeAttachments() {
    return [...subscriptions].filter(([, state]) => state === 'active').map(([id]) => id);
  }

  function quiesce(reason?: string) {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    cancelDelay?.();
    cancelDelay = undefined;
    pending.length = 0;
    retained.clear();
    retainedBytes = 0;
    losses.clear();
    for (const attachmentId of subscriptions.keys()) subscriptions.set(attachmentId, 'lost');
    if (reason !== undefined) options.diagnostic(reason);
  }

  async function flush() {
    if (pending.length === 0 && losses.size === 0) return;
    const identity = options.identity();
    if (identity === null) {
      quiesce('identity_unavailable');
      return;
    }
    if (losses.size > 0) {
      const attachmentIds: string[] = [];
      for (const attachmentId of losses) {
        if (attachmentIds.length >= NATIVE_DELIVERY_LIMITS.count) break;
        const candidate = {
          ...identity,
          kind: 'loss',
          generation: options.generation(),
          attachmentIds: [...attachmentIds, attachmentId],
          deadlineAt: Date.now() + NATIVE_DELIVERY_LIMITS.ageMs,
        };
        if (size(candidate) > NATIVE_DELIVERY_LIMITS.batchBytes) break;
        attachmentIds.push(attachmentId);
      }
      if (attachmentIds.length === 0) {
        losses.clear();
        options.diagnostic('oversized_loss_signal');
        return;
      }
      for (const attachmentId of attachmentIds) losses.delete(attachmentId);
      try {
        await options.send(
          {
            ...identity,
            kind: 'loss',
            generation: options.generation(),
            attachmentIds,
          },
          Date.now() + NATIVE_DELIVERY_LIMITS.ageMs
        );
      } catch {
        options.diagnostic('loss_signal_failed');
      }
      return;
    }
    const attachments = activeAttachments();
    if (attachments.length === 0) {
      discardPending();
      return;
    }
    const first = pending[0];
    if (first === undefined) return;
    if (first.deadlineAt <= Date.now()) {
      lose(attachments, 'expired');
      discardPending();
      return;
    }
    const batch: Extract<NativeEventBatch, { kind: 'events' }> = {
      ...identity,
      kind: 'events',
      generation: options.generation(),
      firstSequence: first.sequence,
      events: [],
    };
    const entries: Entry[] = [];
    while (pending.length > 0) {
      const next = pending[0];
      if (next === undefined) break;
      batch.events.push(next.event);
      if (size({ ...batch, deadlineAt: first.deadlineAt }) > NATIVE_DELIVERY_LIMITS.batchBytes) {
        batch.events.pop();
        break;
      }
      pending.shift();
      entries.push(next);
    }
    if (entries.length === 0) {
      lose(attachments, 'oversized');
      discardPending();
      return;
    }
    try {
      await options.send(batch, first.deadlineAt);
    } catch {
      if (entries.some(entry => retained.has(entry))) lose(attachments, 'delivery_failed');
    } finally {
      for (const entry of entries) {
        if (retained.delete(entry)) retainedBytes -= entry.bytes;
      }
    }
  }

  function schedule() {
    if (scheduled || (pending.length === 0 && losses.size === 0)) return;
    scheduled = true;
    options.waitUntil(
      new Promise<void>(resolve => {
        cancelDelay = resolve;
        timer = setTimeout(() => {
          timer = undefined;
          cancelDelay = undefined;
          resolve();
        }, NATIVE_DELIVERY_LIMITS.coalesceMs);
      })
        .then(async () => {
          await flush();
          if (activeAttachments().length > 0 && options.identity() === null)
            quiesce('identity_unavailable');
        })
        .catch(() => quiesce('unexpected_flush_error'))
        .finally(() => {
          scheduled = false;
          schedule();
        })
    );
  }

  return {
    close() {
      quiesce();
      subscriptions.clear();
    },
    subscribe(attachmentId: string) {
      subscriptions.set(attachmentId, subscriptions.get(attachmentId) ?? 'active');
      return { generation: options.generation(), sequence };
    },
    refresh(attachmentId: string, generation: number) {
      return generation === options.generation() && subscriptions.get(attachmentId) === 'active';
    },
    release(attachmentId: string) {
      subscriptions.delete(attachmentId);
      losses.delete(attachmentId);
      if (subscriptions.size === 0) discardPending();
    },
    enqueue(event: Event) {
      const attachments = activeAttachments();
      if (attachments.length === 0) return;
      sequence++;
      const bytes = size(event.event);
      if (!canRetainNativeEvent(retained.size, retainedBytes, bytes)) {
        lose(attachments, bytes > NATIVE_DELIVERY_LIMITS.eventBytes ? 'oversized' : 'overflow');
        discardPending();
      } else {
        const entry = {
          event,
          sequence,
          bytes,
          deadlineAt: Date.now() + NATIVE_DELIVERY_LIMITS.ageMs,
        };
        pending.push(entry);
        retained.add(entry);
        retainedBytes += bytes;
      }
      schedule();
    },
    snapshot() {
      return {
        count: retained.size,
        bytes: retainedBytes,
        sequence,
        subscriptions: subscriptions.size,
      };
    },
  };
}
