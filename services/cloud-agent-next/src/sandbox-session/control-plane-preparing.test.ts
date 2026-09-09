import { describe, expect, it, vi } from 'vitest';
import { createMemoryEventQueries } from '../session/preparation-test-helpers.js';
import { applyControlPlanePreparingEvent } from './control-plane-preparing.js';

describe('applyControlPlanePreparingEvent', () => {
  const event = {
    version: 2,
    attemptId: 'att_1',
    triggerMessageId: 'msg_1',
    revision: 1,
    timestamp: 10,
    step: 'cloning',
    message: 'Cloning repository…',
    action: 'attempt_started',
  };

  it('broadcasts only an accepted v2 preparing event', () => {
    const broadcast = vi.fn();
    const applied = applyControlPlanePreparingEvent({
      sessionId: 'workspace_1',
      data: event,
      eventQueries: createMemoryEventQueries(),
      broadcast,
    });

    expect(applied).toBe(true);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'workspace_1', stream_event_type: 'preparing' })
    );
  });

  it('does not broadcast a rejected duplicate event', () => {
    const broadcast = vi.fn();
    const eventQueries = createMemoryEventQueries();
    applyControlPlanePreparingEvent({
      sessionId: 'workspace_1',
      data: event,
      eventQueries,
      broadcast,
    });
    broadcast.mockClear();

    const applied = applyControlPlanePreparingEvent({
      sessionId: 'workspace_1',
      data: event,
      eventQueries,
      broadcast,
    });

    expect(applied).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
