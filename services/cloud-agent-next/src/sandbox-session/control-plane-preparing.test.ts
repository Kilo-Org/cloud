import { describe, expect, it, vi } from 'vitest';
import { applyControlPlanePreparingEvent } from './control-plane-preparing.js';

describe('applyControlPlanePreparingEvent', () => {
  it('broadcasts preparing and cloud.status when the event materializes', () => {
    const upsert = vi.fn();
    const broadcast = vi.fn();
    const applied = applyControlPlanePreparingEvent({
      sessionId: 'workspace_1',
      data: {
        version: 2,
        attemptId: 'att_1',
        triggerMessageId: 'msg_1',
        revision: 1,
        timestamp: 10,
        step: 'cloning',
        message: 'Cloning repository…',
        action: 'attempt_started',
      },
      eventQueries: {
        upsert,
        insert: vi.fn(),
        findByEntityId: vi.fn().mockReturnValue(undefined),
        findByEntityPrefix: vi.fn().mockReturnValue([]),
      } as never,
      broadcast,
    });
    expect(applied).toBe(true);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'workspace_1',
        stream_event_type: 'preparing',
      })
    );
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        stream_event_type: 'cloud.status',
      })
    );
  });
});
