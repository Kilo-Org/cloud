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
      eventQueries: { upsert, insert },
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
