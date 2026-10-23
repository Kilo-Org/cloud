import { describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '../websocket/types.js';
import {
  createNativeAttachmentRegistry,
  canRetainNativeEvent,
  NATIVE_DELIVERY_LIMITS,
  isDeliverableNativeEvent,
  isMaterializedNativeEvent,
  MAX_PENDING_NATIVE_EVENTS,
  toNativePublicEvent,
  type NativeEventDelivery,
  type NativeEventBatch,
} from './native-event-source.js';
import { publicCloudAgentDirectory } from './public-sdk-projection.js';

const kiloSessionId = 'ses_12345678901234567890123456';
const cloudAgentSessionId = 'workspace_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('native delivery admission', () => {
  it('extends only large-event backlogs to 320 KiB while preserving per-event and count bounds', () => {
    expect(canRetainNativeEvent(0, 0, NATIVE_DELIVERY_LIMITS.eventBytes)).toBe(true);
    expect(canRetainNativeEvent(0, 0, NATIVE_DELIVERY_LIMITS.eventBytes + 1)).toBe(false);
    expect(canRetainNativeEvent(1, NATIVE_DELIVERY_LIMITS.eventBytes, 1)).toBe(true);
    expect(canRetainNativeEvent(1, 128 * 1024, 128 * 1024)).toBe(true);
    expect(
      canRetainNativeEvent(1, NATIVE_DELIVERY_LIMITS.bytes, NATIVE_DELIVERY_LIMITS.eventBytes)
    ).toBe(true);
    expect(
      canRetainNativeEvent(1, NATIVE_DELIVERY_LIMITS.bytes + 1, NATIVE_DELIVERY_LIMITS.eventBytes)
    ).toBe(false);
    expect(canRetainNativeEvent(2, NATIVE_DELIVERY_LIMITS.retainedBytes - 1, 1)).toBe(true);
    expect(canRetainNativeEvent(2, NATIVE_DELIVERY_LIMITS.retainedBytes, 1)).toBe(false);
    expect(canRetainNativeEvent(1, NATIVE_DELIVERY_LIMITS.bytes - 1, 1)).toBe(true);
    expect(canRetainNativeEvent(1, NATIVE_DELIVERY_LIMITS.bytes, 1)).toBe(false);
    expect(canRetainNativeEvent(NATIVE_DELIVERY_LIMITS.count, 0, 1)).toBe(false);
  });
});

function streamEvent(id: number, data: unknown, type = 'kilocode'): StreamEvent {
  return {
    eventId: id,
    sessionId: 'workspace_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as StreamEvent['sessionId'],
    streamEventType: type as StreamEvent['streamEventType'],
    timestamp: new Date(1_700_000_000_000 + id).toISOString(),
    data,
  };
}

function delivery(id: number): NativeEventDelivery {
  return {
    cloudAgentSessionId,
    kiloSessionId,
    eventId: id,
    event: { type: 'message.updated', properties: { sessionID: kiloSessionId, id: `msg_${id}` } },
  };
}

describe('toNativePublicEvent', () => {
  it('re-owns a native event to the public session directory', () => {
    expect(
      toNativePublicEvent(
        streamEvent(7, {
          type: 'message.part.updated',
          properties: {
            sessionID: kiloSessionId,
            part: { id: 'prt_1' },
            directory: '/workspace/x',
          },
        }),
        kiloSessionId
      )
    ).toEqual({
      type: 'message.part.updated',
      properties: {
        sessionID: kiloSessionId,
        part: { id: 'prt_1' },
        directory: publicCloudAgentDirectory(kiloSessionId),
      },
    });
  });

  it('keeps a preparation progress event in its reported shape', () => {
    expect(
      toNativePublicEvent(
        streamEvent(
          3,
          {
            event: 'cloud.status',
            properties: { sessionID: kiloSessionId, cloudStatus: { type: 'ready' } },
          },
          'preparing'
        ),
        kiloSessionId
      )
    ).toEqual({
      type: 'cloud.status',
      properties: {
        sessionID: kiloSessionId,
        cloudStatus: { type: 'ready' },
        directory: publicCloudAgentDirectory(kiloSessionId),
      },
    });
  });

  it.each(['event', 'type'])('projects captured assistant path metadata in a %s envelope', key => {
    const info = {
      id: 'msg_captured',
      sessionID: kiloSessionId,
      role: 'assistant',
      path: { cwd: '/workspace/app', root: '/workspace/app' },
      time: { created: 100, completed: 101 },
      tokens: { input: 10, output: 1 },
    };
    expect(
      toNativePublicEvent(
        streamEvent(8, { [key]: 'message.updated', properties: { info } }),
        kiloSessionId
      )
    ).toEqual({
      type: 'message.updated',
      properties: {
        info: {
          ...info,
          path: {
            cwd: publicCloudAgentDirectory(kiloSessionId),
            root: publicCloudAgentDirectory(kiloSessionId),
          },
        },
        sessionID: kiloSessionId,
        directory: publicCloudAgentDirectory(kiloSessionId),
      },
    });
    expect(info.path).toEqual({ cwd: '/workspace/app', root: '/workspace/app' });
  });

  it.each(['session.created', 'session.updated'])(
    'projects captured %s nested directory without dropping SDK fields',
    type => {
      const info = {
        id: kiloSessionId,
        directory: '/workspace/app',
        title: 'Keep /workspace/app in my title',
        path: { cwd: '/workspace/app' },
      };
      expect(
        toNativePublicEvent(streamEvent(9, { event: type, properties: { info } }), kiloSessionId)
      ).toMatchObject({
        properties: {
          info: {
            ...info,
            directory: publicCloudAgentDirectory(kiloSessionId),
            path: { cwd: publicCloudAgentDirectory(kiloSessionId) },
          },
        },
      });
    }
  );

  it('projects pending permission metadata in the scoped SSE feed without rewriting added contents', () => {
    const patch =
      'Index: /workspace/app/native-permission.txt\n--- /workspace/app/native-permission.txt\n+++ /workspace/app/native-permission.txt\n@@ -0,0 +1 @@\n+Keep /workspace/app/native-permission.txt';
    expect(
      toNativePublicEvent(
        streamEvent(10, {
          event: 'permission.asked',
          properties: {
            id: 'per_captured',
            sessionID: kiloSessionId,
            permission: 'edit',
            patterns: ['native-permission.txt'],
            metadata: {
              filepath: '/workspace/app/native-permission.txt',
              diff: patch,
              filediff: {
                file: '/workspace/app/native-permission.txt',
                patch,
                additions: 1,
                deletions: 0,
              },
            },
          },
        }),
        kiloSessionId
      )
    ).toMatchObject({
      properties: {
        id: 'per_captured',
        permission: 'edit',
        patterns: ['native-permission.txt'],
        metadata: {
          filepath: publicCloudAgentDirectory(kiloSessionId),
          diff: `Index: ${publicCloudAgentDirectory(kiloSessionId)}\n--- ${publicCloudAgentDirectory(kiloSessionId)}\n+++ ${publicCloudAgentDirectory(kiloSessionId)}\n@@ -0,0 +1 @@\n+Keep /workspace/app/native-permission.txt`,
          filediff: { file: publicCloudAgentDirectory(kiloSessionId), additions: 1, deletions: 0 },
        },
      },
    });
  });

  it('classifies stored kilocode autocommit updates as materialized and deliverable', () => {
    const event = streamEvent(2, {
      event: 'autocommit_completed',
      properties: { messageId: 'msg_commit', success: true },
    });
    expect(isDeliverableNativeEvent(event)).toBe(true);
    expect(isMaterializedNativeEvent(event)).toBe(true);
    expect(toNativePublicEvent(event, kiloSessionId)).toMatchObject({
      type: 'autocommit_completed',
      properties: { messageId: 'msg_commit', success: true },
    });
    expect(isMaterializedNativeEvent(streamEvent(3, { type: 'autocommit_completed' }))).toBe(true);
    expect(isMaterializedNativeEvent(streamEvent(4, { event: 'session.updated' }))).toBe(false);
    expect(isDeliverableNativeEvent(streamEvent(0, event.data))).toBe(false);
    expect(
      isDeliverableNativeEvent(streamEvent(2, { messageId: 'msg_commit' }, 'autocommit_completed'))
    ).toBe(false);
  });

  it('drops an event that names another session', () => {
    expect(
      toNativePublicEvent(
        streamEvent(
          4,
          {
            event: 'message.updated',
            properties: { sessionID: 'ses_other_session_identifier_00' },
          },
          'preparing'
        ),
        kiloSessionId
      )
    ).toBeNull();
  });

  it('does not deliver synthetic or interior rows', () => {
    expect(isDeliverableNativeEvent(streamEvent(0, {}))).toBe(false);
    expect(isDeliverableNativeEvent(streamEvent(1, {}, 'progress'))).toBe(false);
    expect(isDeliverableNativeEvent(streamEvent(2, {}, 'cloud.message.completed'))).toBe(true);
  });

  it('allows only named transient text deltas on the live path, never in snapshot replay', () => {
    const delta = streamEvent(0, {
      type: 'message.part.delta',
      properties: { sessionID: kiloSessionId, delta: 'text' },
    });
    expect(isDeliverableNativeEvent(delta)).toBe(false);
    expect(isDeliverableNativeEvent(delta, true)).toBe(true);
    expect(isDeliverableNativeEvent(streamEvent(0, { type: 'message.updated' }), true)).toBe(false);
    expect(
      isDeliverableNativeEvent(streamEvent(0, { type: 'cloud.status' }, 'cloud.status'), true)
    ).toBe(false);
  });
});

describe('createNativeAttachmentRegistry', () => {
  function batch(firstSequence: number, values = ['a', 'b'], generation = 1): NativeEventBatch {
    return {
      kiloUserId: 'owner',
      cloudAgentSessionId,
      kiloSessionId,
      kind: 'events',
      generation,
      firstSequence,
      events: values.map(value => ({
        eventId: 2,
        materialized: true,
        event: { type: 'message.part.updated', properties: { value } },
      })),
    };
  }

  it.each([70, 128, 240])(
    'delivers a %s KiB event intact live and after a snapshot cutover',
    kib => {
      for (const phase of ['live', 'snapshot']) {
        const lost = vi.fn();
        const registry = createNativeAttachmentRegistry(lost);
        const received = vi.fn();
        registry.begin(cloudAgentSessionId, kiloSessionId, phase);
        registry.bind(phase, { generation: 1, sequence: 0 });
        registry.subscribe(phase, received);
        if (phase === 'live') registry.complete(phase, 0);
        const large = batch(1, ['\u00e9'.repeat((kib * 1024) / 2)]);
        registry.deliverBatch(large, [phase]);
        if (phase === 'snapshot') {
          expect(received).not.toHaveBeenCalled();
          registry.complete(phase, 0);
        }
        expect(received).toHaveBeenCalledExactlyOnceWith(
          large.kind === 'events' ? large.events[0]?.event : undefined
        );
        registry.deliverBatch(batch(2, ['after flush']), [phase]);
        expect(received).toHaveBeenCalledTimes(2);
        expect(lost).not.toHaveBeenCalled();
      }
    }
  );

  it('bounds multiple queued events to the aggregate 64 KiB UTF-8 backlog', () => {
    const lost = vi.fn();
    const registry = createNativeAttachmentRegistry(lost);
    registry.begin(cloudAgentSessionId, kiloSessionId, 'attachment');
    registry.bind('attachment', { generation: 1, sequence: 0 });
    const received = vi.fn();
    registry.subscribe('attachment', received);
    registry.deliverBatch(batch(1, ['\u00e9'.repeat(20_000)]), ['attachment']);
    registry.deliverBatch(batch(2, ['\u00e9'.repeat(20_000)]), ['attachment']);
    registry.complete('attachment', 0);
    expect(lost).toHaveBeenCalledExactlyOnceWith('attachment', kiloSessionId);
    expect(received).not.toHaveBeenCalled();
  });

  it('reports loss above the aggregate 320 KiB payload bound during snapshot', () => {
    const lost = vi.fn();
    const registry = createNativeAttachmentRegistry(lost);
    registry.begin(cloudAgentSessionId, kiloSessionId, 'attachment');
    registry.bind('attachment', { generation: 1, sequence: 0 });
    registry.deliverBatch(batch(1, ['x'.repeat(128 * 1024)]), ['attachment']);
    registry.deliverBatch(batch(2, ['y'.repeat(240 * 1024)]), ['attachment']);
    expect(lost).toHaveBeenCalledExactlyOnceWith('attachment', kiloSessionId);
    expect(registry.isLost('attachment')).toBe(true);
  });

  it.each([70, 128, 240])(
    'buffers small metadata, a %s KiB event, and small completion through snapshot in order',
    kib => {
      const lost = vi.fn();
      const registry = createNativeAttachmentRegistry(lost);
      registry.begin(cloudAgentSessionId, kiloSessionId, 'attachment');
      registry.bind('attachment', { generation: 1, sequence: 0 });
      const received = vi.fn();
      registry.subscribe('attachment', received);
      const values = ['metadata', '\u00e9'.repeat((kib * 1024) / 2), 'completion'];
      registry.deliverBatch(batch(1, values), ['attachment']);
      expect(received).not.toHaveBeenCalled();
      registry.complete('attachment', 0);
      expect(received.mock.calls.map(([event]) => event.properties.value)).toEqual(values);
      expect(lost).not.toHaveBeenCalled();
    }
  );

  it.each(['snapshot', 'live'])(
    'reports an explicit per-event maximum violation in %s phase',
    phase => {
      const lost = vi.fn();
      const registry = createNativeAttachmentRegistry(lost);
      registry.begin(cloudAgentSessionId, kiloSessionId, phase);
      registry.bind(phase, { generation: 1, sequence: 0 });
      if (phase === 'live') registry.complete(phase, 0);
      const received = vi.fn();
      registry.subscribe(phase, received);
      registry.deliverBatch(batch(1, ['x'.repeat(NATIVE_DELIVERY_LIMITS.eventBytes)]), [phase]);
      registry.complete(phase, 0);
      expect(lost).toHaveBeenCalledExactlyOnceWith(phase, kiloSessionId);
      expect(received).not.toHaveBeenCalled();
    }
  );

  it('delivers transient zero-ID deltas after the snapshot fence exactly once in producer order', () => {
    const lost = vi.fn();
    const registry = createNativeAttachmentRegistry(lost);
    registry.begin(cloudAgentSessionId, kiloSessionId, 'attachment');
    registry.bind('attachment', { generation: 1, sequence: 0 });
    registry.complete('attachment', 100);
    const received = vi.fn();
    registry.subscribe('attachment', received);
    const deltas: NativeEventBatch = {
      ...batch(1),
      kind: 'events',
      firstSequence: 1,
      events: ['first', 'second'].map(delta => ({
        eventId: 0,
        event: { type: 'message.part.delta', properties: { delta } },
      })),
    };
    registry.deliverBatch(deltas, ['attachment']);
    registry.deliverBatch(deltas, ['attachment']);
    expect(received.mock.calls.map(([event]) => event.properties.delta)).toEqual([
      'first',
      'second',
    ]);
    expect(lost).not.toHaveBeenCalled();
  });

  it('requires a resnapshot if post-subscribe transient deltas race the materialized snapshot', () => {
    const lost = vi.fn();
    const registry = createNativeAttachmentRegistry(lost);
    registry.begin(cloudAgentSessionId, kiloSessionId, 'attachment');
    const deltas: NativeEventBatch = {
      ...batch(1),
      kind: 'events',
      firstSequence: 1,
      events: [
        { eventId: 0, event: { type: 'message.part.delta', properties: { delta: 'ambiguous' } } },
      ],
    };
    registry.deliverBatch(deltas, ['attachment']);
    registry.bind('attachment', { generation: 1, sequence: 0 });
    registry.complete('attachment', 100);
    expect(lost).toHaveBeenCalledExactlyOnceWith('attachment', kiloSessionId);
    const received = vi.fn();
    registry.subscribe('attachment', received);
    expect(received).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: 'kilo.native.resnapshot' })
    );
  });

  it('does not invalidate a fresh snapshot for a transient captured before it subscribed', () => {
    const lost = vi.fn();
    const registry = createNativeAttachmentRegistry(lost);
    registry.begin(cloudAgentSessionId, kiloSessionId, 'attachment');
    registry.deliverBatch(
      {
        ...batch(1),
        kind: 'events',
        firstSequence: 1,
        events: [
          { eventId: 0, event: { type: 'message.part.delta', properties: { delta: 'older' } } },
        ],
      },
      ['attachment']
    );
    registry.bind('attachment', { generation: 1, sequence: 1 });
    registry.complete('attachment', 100);
    expect(lost).not.toHaveBeenCalled();
  });

  it('uses producer sequence to replay retained row IDs once and rejects late older batches', () => {
    const lost = vi.fn();
    const registry = createNativeAttachmentRegistry(lost);
    registry.begin(cloudAgentSessionId, kiloSessionId, 'attachment');
    registry.bind('attachment', { generation: 1, sequence: 0 });
    registry.complete('attachment', 100);
    const received = vi.fn();
    registry.subscribe('attachment', received);
    registry.deliverBatch(batch(1), ['attachment']);
    registry.deliverBatch(batch(1), ['attachment']);
    registry.deliverBatch(batch(3, ['c']), ['attachment']);
    registry.deliverBatch(batch(1, ['late']), ['attachment']);
    expect(received.mock.calls.map(([event]) => event.properties.value)).toEqual(['a', 'b', 'c']);
    expect(lost).not.toHaveBeenCalled();
  });

  it('excludes events captured before subscription even when mutable row IDs stay below the fence', () => {
    const registry = createNativeAttachmentRegistry(vi.fn());
    registry.begin(cloudAgentSessionId, kiloSessionId, 'attachment');
    const received = vi.fn();
    registry.subscribe('attachment', received);
    registry.deliverBatch(batch(1, ['captured before subscribe', 'after subscribe']), [
      'attachment',
    ]);
    registry.bind('attachment', { generation: 1, sequence: 1 });
    registry.complete('attachment', 100);
    registry.deliverBatch(batch(3, ['later']), ['attachment']);
    expect(received.mock.calls.map(([event]) => event.properties.value)).toEqual([
      'after subscribe',
      'later',
    ]);
  });

  it('signals a sequence gap once before any subsequent update while a sibling remains healthy', () => {
    const lost = vi.fn();
    const registry = createNativeAttachmentRegistry(lost);
    registry.begin(cloudAgentSessionId, kiloSessionId, 'root');
    registry.bind('root', { generation: 1, sequence: 0 });
    registry.complete('root', 0);
    registry.begin('sibling', 'ses_sibling', 'sibling');
    registry.bind('sibling', { generation: 1, sequence: 0 });
    registry.complete('sibling', 0);
    const root = vi.fn();
    const sibling = vi.fn();
    registry.subscribe('root', root);
    registry.subscribe('sibling', sibling);
    registry.deliverBatch(batch(2), ['root', 'sibling']);
    registry.deliverBatch(batch(4), ['root']);
    registry.deliverBatch(
      { ...batch(1), cloudAgentSessionId: 'sibling', kiloSessionId: 'ses_sibling' },
      ['sibling']
    );
    expect(lost).toHaveBeenCalledExactlyOnceWith('root', kiloSessionId);
    expect(root).not.toHaveBeenCalled();
    expect(sibling).toHaveBeenCalledTimes(2);
  });

  it('ignores old generations and invalidates a surviving attachment on producer reconstruction', () => {
    const lost = vi.fn();
    const registry = createNativeAttachmentRegistry(lost);
    registry.begin(cloudAgentSessionId, kiloSessionId, 'attachment');
    registry.bind('attachment', { generation: 2, sequence: 0 });
    registry.complete('attachment', 0);
    const received = vi.fn();
    registry.subscribe('attachment', received);
    registry.deliverBatch(batch(1, ['old'], 1), ['attachment']);
    registry.deliverBatch(
      {
        kiloUserId: 'owner',
        cloudAgentSessionId,
        kiloSessionId,
        generation: 1,
        kind: 'loss',
        attachmentIds: ['attachment'],
      },
      ['attachment']
    );
    expect(lost).not.toHaveBeenCalled();
    registry.deliverBatch(batch(1, ['restart'], 3), ['attachment']);
    expect(lost).toHaveBeenCalledOnce();
    expect(received).not.toHaveBeenCalled();
  });

  it('isolates loss notices to their captured attachments and refuses later delivery to them', () => {
    const lost = vi.fn();
    const registry = createNativeAttachmentRegistry(lost);
    for (const id of ['old', 'new']) {
      registry.begin(cloudAgentSessionId, kiloSessionId, id);
      registry.bind(id, { generation: 1, sequence: 0 });
      registry.complete(id, 0);
    }
    const received = vi.fn();
    registry.subscribe('new', received);
    registry.deliverBatch(
      {
        kiloUserId: 'owner',
        cloudAgentSessionId,
        kiloSessionId,
        generation: 1,
        kind: 'loss',
        attachmentIds: ['old'],
      },
      ['old', 'new']
    );
    registry.deliverBatch(batch(1), ['old', 'new']);
    expect(lost).toHaveBeenCalledExactlyOnceWith('old', kiloSessionId);
    expect(received).toHaveBeenCalledTimes(2);
    registry.release('old');
    registry.invalidate('old');
    expect(lost).toHaveBeenCalledOnce();
  });
  it('replays an autocommit rewrite below the completed fence after its stable-ID snapshot', () => {
    const registry = createNativeAttachmentRegistry(vi.fn());
    const listener = vi.fn();
    registry.begin(cloudAgentSessionId, kiloSessionId);
    registry.subscribe(cloudAgentSessionId, listener);
    const event = streamEvent(2, {
      event: 'autocommit_completed',
      properties: { messageId: 'msg_commit', success: true, pushed: true },
    });
    const native = toNativePublicEvent(event, kiloSessionId);
    if (native === null) throw new Error('expected autocommit event');
    registry.deliver({
      ...delivery(2),
      event: native,
      materialized: isMaterializedNativeEvent(event),
    });
    registry.complete(cloudAgentSessionId, 12);
    expect(listener).toHaveBeenCalledExactlyOnceWith(native);
    registry.deliver({
      ...delivery(2),
      event: native,
      materialized: isMaterializedNativeEvent(event),
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });
  it('replays materialized rewrites below the page cursor and fence in observation order', () => {
    const registry = createNativeAttachmentRegistry(vi.fn());
    const listener = vi.fn();
    registry.begin(cloudAgentSessionId, kiloSessionId);
    registry.subscribe(cloudAgentSessionId, listener);
    registry.deliver({ ...delivery(2), materialized: true });
    registry.deliver({
      ...delivery(2),
      materialized: true,
      event: { type: 'message.updated', properties: { id: 'msg_2', body: 'newer' } },
    });
    registry.deliver(delivery(11));
    expect(listener).not.toHaveBeenCalled();
    registry.complete(cloudAgentSessionId, 12);
    expect(listener.mock.calls.map(([event]) => event.properties)).toEqual([
      { sessionID: kiloSessionId, id: 'msg_2' },
      { id: 'msg_2', body: 'newer' },
    ]);
    registry.deliver({ ...delivery(1), materialized: true });
    expect(listener).toHaveBeenLastCalledWith(delivery(1).event);
    registry.deliver(delivery(12));
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('reports only the overflowing attachment while a healthy attachment keeps receiving', () => {
    const overflow = vi.fn();
    const registry = createNativeAttachmentRegistry(overflow);
    const healthy = vi.fn();
    registry.begin(cloudAgentSessionId, kiloSessionId, 'slow');
    registry.begin(cloudAgentSessionId, kiloSessionId, 'healthy');
    registry.subscribe('healthy', healthy);
    registry.complete('healthy', 0);
    for (let id = 1; id <= MAX_PENDING_NATIVE_EVENTS + 1; id++) registry.deliver(delivery(id));
    expect(overflow).toHaveBeenCalledExactlyOnceWith('slow', kiloSessionId);
    expect(healthy).toHaveBeenCalledTimes(MAX_PENDING_NATIVE_EVENTS + 1);
    expect(healthy.mock.calls.every(([event]) => event.type !== 'kilo.native.resnapshot')).toBe(
      true
    );
  });

  it('delivers live pushes after completing a valid empty-log fence', () => {
    const registry = createNativeAttachmentRegistry(vi.fn());
    const listener = vi.fn();
    registry.begin(cloudAgentSessionId, kiloSessionId);
    registry.subscribe(cloudAgentSessionId, listener);
    registry.deliver(delivery(1));
    expect(listener).not.toHaveBeenCalled();
    registry.complete(cloudAgentSessionId, null);
    registry.deliver(delivery(2));
    expect(listener.mock.calls.map(([event]) => event.properties.id)).toEqual(['msg_1', 'msg_2']);
  });

  it('keeps concurrent attachment fences and releases independent', () => {
    const registry = createNativeAttachmentRegistry(vi.fn());
    const first = vi.fn();
    const second = vi.fn();
    registry.begin(cloudAgentSessionId, kiloSessionId, 'first');
    registry.subscribe('first', first);
    registry.complete('first', 3);
    registry.begin(cloudAgentSessionId, kiloSessionId, 'second');
    registry.subscribe('second', second);
    registry.deliver(delivery(4));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    registry.complete('second', 4);
    registry.release('first');
    registry.deliver(delivery(5));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
  it('drops pushed events already covered by the snapshot fence', () => {
    const registry = createNativeAttachmentRegistry(() => undefined);
    const received: number[] = [];
    registry.begin(cloudAgentSessionId, kiloSessionId);
    registry.subscribe(cloudAgentSessionId, event => {
      received.push(Number((event.properties as { id?: string }).id?.replace('msg_', '')));
    });
    registry.deliver(delivery(5));
    registry.complete(cloudAgentSessionId, 10);
    registry.deliver(delivery(10));
    registry.deliver(delivery(11));
    expect(received).toEqual([11]);
  });

  it('buffers events pushed before the fence and drains them in order', () => {
    const registry = createNativeAttachmentRegistry(() => undefined);
    const received: string[] = [];
    registry.begin(cloudAgentSessionId, kiloSessionId);
    registry.subscribe(cloudAgentSessionId, event => received.push(String(event.type)));
    registry.deliver(delivery(12));
    registry.deliver(delivery(13));
    expect(received).toEqual([]);
    registry.complete(cloudAgentSessionId, 10);
    expect(received).toEqual(['message.updated', 'message.updated']);
  });

  it('asks for a resnapshot when the pending buffer cannot prove continuity', () => {
    const overflow = vi.fn();
    const registry = createNativeAttachmentRegistry(overflow);
    registry.begin(cloudAgentSessionId, kiloSessionId);
    for (let id = 1; id <= MAX_PENDING_NATIVE_EVENTS; id++) registry.deliver(delivery(id));
    registry.deliver(delivery(MAX_PENDING_NATIVE_EVENTS + 1));
    expect(overflow).toHaveBeenCalledWith(cloudAgentSessionId, kiloSessionId);
    const received: unknown[] = [];
    registry.subscribe(cloudAgentSessionId, event => received.push(event));
    registry.complete(cloudAgentSessionId, null);
    registry.deliver(delivery(9999));
    expect(received).toEqual([expect.objectContaining({ type: 'kilo.native.resnapshot' })]);
  });

  it('ignores a push for a different native session on the same attachment', () => {
    const registry = createNativeAttachmentRegistry(() => undefined);
    const received: unknown[] = [];
    registry.begin(cloudAgentSessionId, kiloSessionId);
    registry.complete(cloudAgentSessionId, 0);
    registry.subscribe(cloudAgentSessionId, event => received.push(event));
    registry.deliver({ ...delivery(5), kiloSessionId: 'ses_sibling_session_identifier_0' });
    expect(received).toEqual([]);
  });
});
