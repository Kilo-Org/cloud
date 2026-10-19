import { describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '../websocket/types.js';
import {
  createNativeAttachmentRegistry,
  isDeliverableNativeEvent,
  MAX_PENDING_NATIVE_EVENTS,
  toNativePublicEvent,
  type NativeEventDelivery,
} from './native-event-source.js';
import { publicCloudAgentDirectory } from './public-sdk-projection.js';

const kiloSessionId = 'ses_12345678901234567890123456';
const cloudAgentSessionId = 'workspace_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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
});

describe('createNativeAttachmentRegistry', () => {
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
