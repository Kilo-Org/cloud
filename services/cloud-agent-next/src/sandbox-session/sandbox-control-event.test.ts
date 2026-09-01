import { describe, expect, it, vi } from 'vitest';
import { persistSandboxControlSessionEvent } from './sandbox-control-event.js';

describe('persistSandboxControlSessionEvent', () => {
  it('upserts message.updated by entity id', () => {
    const upsert = vi.fn().mockReturnValue(12);
    const insert = vi.fn();
    const broadcast = vi.fn();

    persistSandboxControlSessionEvent({
      sessionId: 'agent_1',
      payload: {
        type: 'message.updated',
        properties: { info: { id: 'msg_1' } },
        timestamp: '2026-08-20T00:00:00.000Z',
      },
      eventQueries: { upsert, insert, insertUnique: vi.fn() },
      broadcast,
    });

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'agent_1',
        streamEventType: 'kilocode',
        entityId: 'message/msg_1',
        payload: JSON.stringify({
          type: 'message.updated',
          event: 'message.updated',
          properties: { info: { id: 'msg_1' } },
        }),
      })
    );
    expect(insert).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ id: 12, session_id: 'agent_1' })
    );
  });

  it('inserts persisted kilo names without entity id', () => {
    const upsert = vi.fn();
    const insert = vi.fn().mockReturnValue(3);
    persistSandboxControlSessionEvent({
      sessionId: 'agent_1',
      payload: { type: 'session.idle', properties: {} },
      eventQueries: { upsert, insert, insertUnique: vi.fn() },
      broadcast: vi.fn(),
    });
    expect(upsert).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledOnce();
  });

  it('inserts a valid local commit even when push failed, without rebroadcasting duplicate metadata', () => {
    const eventQueries = {
      upsert: vi.fn(),
      insert: vi.fn(),
      insertUnique: vi.fn().mockReturnValueOnce(4).mockReturnValue(null),
    };
    const broadcast = vi.fn();
    const properties = {
      commitHash: 'a'.repeat(40),
      commitMessage: 'Actual commit',
      userMessageId: 'user',
      messageId: 'assistant',
      committedAt: '2026-09-01T10:00:00Z',
      pushStatus: 'failed',
      success: false,
      message: 'Push failed',
    };
    const input = {
      sessionId: 'workspace_1',
      payload: { type: 'autocommit_completed', properties },
      eventQueries,
      broadcast,
    };
    expect(persistSandboxControlSessionEvent(input)).toEqual({ applied: true });
    expect(
      persistSandboxControlSessionEvent({
        ...input,
        payload: { ...input.payload, properties: { ...properties, commitMessage: 'Changed' } },
      })
    ).toEqual({ applied: true });
    expect(eventQueries.upsert).not.toHaveBeenCalled();
    expect(eventQueries.insertUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: `commit/${properties.commitHash}`,
        timestamp: Date.parse(properties.committedAt),
      })
    );
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 4,
        payload: JSON.stringify({
          type: 'autocommit_completed',
          event: 'autocommit_completed',
          properties,
        }),
      })
    );
  });

  it.each([
    { skipped: true, commitHash: 'a'.repeat(40) },
    { success: false },
    { commitHash: 'abcdef1' },
  ])('preserves old skipped/failure/short-SHA events without a commit identity', properties => {
    const eventQueries = {
      upsert: vi.fn().mockReturnValue(3),
      insert: vi.fn(),
      insertUnique: vi.fn(),
    };
    const result = persistSandboxControlSessionEvent({
      sessionId: 'workspace_1',
      payload: {
        type: 'autocommit_completed',
        properties: { messageId: 'assistant', ...properties },
      },
      eventQueries,
      broadcast: vi.fn(),
    });
    expect(result).toEqual({ applied: true });
    expect(eventQueries.insertUnique).not.toHaveBeenCalled();
    expect(eventQueries.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'autocommit/assistant' })
    );
  });

  it('broadcasts token deltas without persisting', () => {
    const upsert = vi.fn();
    const insert = vi.fn();
    const broadcast = vi.fn();
    persistSandboxControlSessionEvent({
      sessionId: 'agent_1',
      payload: { type: 'message.part.delta', properties: { text: 'hi' } },
      eventQueries: { upsert, insert, insertUnique: vi.fn() },
      broadcast,
    });
    expect(upsert).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ id: 0 }));
  });
});
