import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '../websocket/types.js';
import {
  createNativeSnapshotReconciler,
  canRetainNativeEvent,
  NATIVE_DELIVERY_LIMITS,
  isDeliverableNativeEvent,
  isMaterializedNativeEvent,
  toNativePublicEvent,
} from './native-event-source.js';
import { publicCloudAgentDirectory } from './public-sdk-projection.js';

const kiloSessionId = 'ses_12345678901234567890123456';

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

  it.each([
    'session.created',
    'session.updated',
    'session.status',
    'conversation.source',
    'conversation.message.updated',
  ])('delivers upserted %s rows even when their stable id precedes the fence', type => {
    const event = streamEvent(2, { event: type, properties: { sessionID: kiloSessionId } });
    expect(isDeliverableNativeEvent(event)).toBe(true);
    expect(isMaterializedNativeEvent(event)).toBe(true);
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
    expect(isMaterializedNativeEvent(streamEvent(4, { event: 'session.error' }))).toBe(false);
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

describe('cloud terminal native projection', () => {
  const directory = publicCloudAgentDirectory(kiloSessionId);

  it('projects a stored completed row from its stream identity without duplicated payload metadata', () => {
    expect(
      toNativePublicEvent(
        streamEvent(
          21,
          {
            messageId: 'msg_completed',
            status: 'completed',
            delivery: 'sent',
            accepted: true,
            assistantMessageId: 'msg_private_assistant',
          },
          'cloud.message.completed'
        ),
        kiloSessionId
      )
    ).toEqual({
      type: 'cloud.message.completed',
      properties: {
        sessionID: kiloSessionId,
        messageId: 'msg_completed',
        status: 'completed',
        delivery: 'sent',
        accepted: true,
        directory,
      },
    });
  });

  it.each([
    [
      'failed',
      {
        messageId: 'msg_failed',
        status: 'failed',
        delivery: 'sent',
        accepted: true,
        reason: 'no_progress',
        error: 'The turn made no progress',
      },
    ],
    [
      'interrupted',
      {
        messageId: 'msg_interrupted',
        status: 'interrupted',
        delivery: 'queued',
        accepted: false,
        reason: 'interrupted',
        error: 'The message was interrupted',
      },
    ],
  ])(
    'projects a stored %s row while retaining status and delivery semantics',
    (status, payload) => {
      const projected = toNativePublicEvent(
        streamEvent(22, payload, 'cloud.message.failed'),
        kiloSessionId
      );
      expect(projected).toEqual({
        type: 'cloud.message.failed',
        properties: {
          sessionID: kiloSessionId,
          messageId: payload.messageId,
          status,
          delivery: payload.delivery,
          accepted: payload.accepted,
          directory,
        },
      });
      expect(projected?.properties).not.toHaveProperty('error');
      expect(projected?.properties).not.toHaveProperty('reason');
    }
  );

  it('drops a malformed Cloud terminal payload instead of inventing a native terminal', () => {
    expect(
      toNativePublicEvent(
        streamEvent(23, { content: 'missing message id' }, 'cloud.message.completed'),
        kiloSessionId
      )
    ).toBeNull();
  });
});

describe('createNativeSnapshotReconciler', () => {
  it('emits the authoritative idle status and reconciles stale and pending interactions', () => {
    const reconciler = createNativeSnapshotReconciler(kiloSessionId);
    for (const event of [
      {
        type: 'session.status',
        properties: { sessionID: kiloSessionId, status: { type: 'busy' } },
      },
      { type: 'question.asked', properties: { sessionID: kiloSessionId, id: 'que_stale' } },
      { type: 'permission.asked', properties: { sessionID: kiloSessionId, id: 'per_stale' } },
      { type: 'question.asked', properties: { sessionID: kiloSessionId, id: 'que_keep' } },
    ]) {
      reconciler.observe(event);
    }

    expect(
      reconciler.corrections({
        sessionStatus: { type: 'idle' },
        questions: [{ id: 'que_new', sessionID: kiloSessionId }],
        permissions: [],
      })
    ).toEqual([
      expect.objectContaining({
        type: 'session.status',
        properties: expect.objectContaining({ status: { type: 'idle' } }),
      }),
      expect.objectContaining({
        type: 'question.asked',
        properties: expect.objectContaining({ id: 'que_new', sessionID: kiloSessionId }),
      }),
      expect.objectContaining({
        type: 'question.rejected',
        properties: expect.objectContaining({ requestID: 'que_stale' }),
      }),
      expect.objectContaining({
        type: 'question.rejected',
        properties: expect.objectContaining({ requestID: 'que_keep' }),
      }),
      expect.objectContaining({
        type: 'permission.replied',
        properties: expect.objectContaining({ requestID: 'per_stale' }),
      }),
    ]);
  });

  it('does not clear interactions when an older snapshot carries no authoritative list', () => {
    const reconciler = createNativeSnapshotReconciler(kiloSessionId);
    reconciler.observe({
      type: 'question.asked',
      properties: { sessionID: kiloSessionId, id: 'que_open' },
    });
    expect(reconciler.corrections({})).toEqual([]);
  });

  it('filters an authoritative interaction from another root session', () => {
    const reconciler = createNativeSnapshotReconciler(kiloSessionId);
    expect(
      reconciler.corrections({
        questions: [
          { id: 'que_other', sessionID: 'ses_other_session_identifier_00' },
          { id: 'que_owned', sessionID: kiloSessionId },
        ],
        permissions: [],
      })
    ).toEqual([
      expect.objectContaining({
        type: 'question.asked',
        properties: expect.objectContaining({ id: 'que_owned' }),
      }),
    ]);
  });
});
