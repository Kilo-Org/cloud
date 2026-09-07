import { describe, expect, it, vi } from 'vitest';
import { persistSandboxControlSessionEvent } from './sandbox-control-event.js';

describe('persistSandboxControlSessionEvent', () => {
  it('upserts a slim message.updated payload while broadcasting the live payload', () => {
    const upsert = vi.fn().mockReturnValue(12);
    const insert = vi.fn();
    const broadcast = vi.fn();

    persistSandboxControlSessionEvent({
      sessionId: 'agent_1',
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_1',
            role: 'assistant',
            parentID: 'user_1',
            sessionID: 'kilo_1',
            time: { completed: 123 },
            error: { data: { message: 'failed', responseBody: 'private' } },
            summary: { diffs: [{ before: 'large diff' }] },
          },
        },
        timestamp: '2026-08-20T00:00:00.000Z',
      },
      eventQueries: { upsert, insert },
      broadcast,
    });

    const persistedPayload = upsert.mock.calls[0]?.[0]?.payload;
    expect(persistedPayload).toBeTypeOf('string');
    if (typeof persistedPayload !== 'string') return;
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'agent_1',
        streamEventType: 'kilocode',
        entityId: 'message/msg_1',
      })
    );
    expect(JSON.parse(persistedPayload)).toEqual({
      type: 'message.updated',
      event: 'message.updated',
      properties: {
        info: {
          id: 'msg_1',
          role: 'assistant',
          parentID: 'user_1',
          sessionID: 'kilo_1',
          time: { completed: 123 },
          error: 'Assistant request failed',
        },
      },
    });
    expect(insert).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 12,
        session_id: 'agent_1',
        payload: JSON.stringify({
          type: 'message.updated',
          event: 'message.updated',
          properties: {
            info: {
              id: 'msg_1',
              role: 'assistant',
              parentID: 'user_1',
              sessionID: 'kilo_1',
              time: { completed: 123 },
              error: { data: { message: 'failed', responseBody: 'private' } },
              summary: { diffs: [{ before: 'large diff' }] },
            },
          },
        }),
      })
    );
  });

  it('upserts text-only message parts while broadcasting the live part payload', () => {
    const upsert = vi.fn().mockReturnValue(12);
    const broadcast = vi.fn();
    persistSandboxControlSessionEvent({
      sessionId: 'agent_1',
      payload: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'kilo_1',
          part: {
            type: 'text',
            id: 'part_1',
            messageID: 'msg_1',
            text: 'Assistant reply',
            metadata: { diff: 'large diff' },
          },
        },
      },
      eventQueries: { upsert, insert: vi.fn() },
      broadcast,
    });

    const persistedPayload = upsert.mock.calls[0]?.[0]?.payload;
    expect(persistedPayload).toBeTypeOf('string');
    if (typeof persistedPayload !== 'string') return;
    expect(JSON.parse(persistedPayload)).toEqual({
      type: 'message.part.updated',
      event: 'message.part.updated',
      properties: {
        sessionID: 'kilo_1',
        part: { type: 'text', id: 'part_1', messageID: 'msg_1', text: 'Assistant reply' },
      },
    });
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.stringContaining('large diff'),
      })
    );
  });

  it('inserts persisted kilo names without entity id', () => {
    const upsert = vi.fn();
    const insert = vi.fn().mockReturnValue(3);
    persistSandboxControlSessionEvent({
      sessionId: 'agent_1',
      payload: { type: 'session.idle', properties: {} },
      eventQueries: { upsert, insert },
      broadcast: vi.fn(),
    });
    expect(upsert).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledOnce();
  });

  it('broadcasts token deltas without persisting', () => {
    const upsert = vi.fn();
    const insert = vi.fn();
    const broadcast = vi.fn();
    persistSandboxControlSessionEvent({
      sessionId: 'agent_1',
      payload: { type: 'message.part.delta', properties: { text: 'hi' } },
      eventQueries: { upsert, insert },
      broadcast,
    });
    expect(upsert).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ id: 0 }));
  });
});
