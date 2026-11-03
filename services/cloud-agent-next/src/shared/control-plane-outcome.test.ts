import { describe, expect, it } from 'vitest';
import { controlPlaneOutcomeSchema } from './control-plane-protocol.js';

describe('controlPlaneOutcomeSchema gateResult invariant', () => {
  it('accepts a gate result on a completed outcome', () => {
    const parsed = controlPlaneOutcomeSchema.safeParse({
      sessionId: 'workspace_test',
      lastMessageId: 'msg_1',
      status: 'completed',
      gateResult: 'fail',
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.gateResult).toBe('fail');
  });

  it('accepts completed and non-completed outcomes without a gate result', () => {
    expect(
      controlPlaneOutcomeSchema.safeParse({
        sessionId: 'workspace_test',
        lastMessageId: 'msg_1',
        status: 'completed',
      }).success
    ).toBe(true);
    expect(
      controlPlaneOutcomeSchema.safeParse({
        sessionId: 'workspace_test',
        lastMessageId: 'msg_1',
        status: 'failed',
      }).success
    ).toBe(true);
    expect(
      controlPlaneOutcomeSchema.safeParse({
        sessionId: 'workspace_test',
        lastMessageId: 'msg_1',
        status: 'cancelled',
      }).success
    ).toBe(true);
  });

  it.each(['failed', 'cancelled'] as const)('rejects a gate result on a %s outcome', status => {
    const parsed = controlPlaneOutcomeSchema.safeParse({
      sessionId: 'workspace_test',
      lastMessageId: 'msg_1',
      status,
      gateResult: 'pass',
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toContainEqual(
      expect.objectContaining({
        message: 'Only completed results can include gateResult',
        path: ['gateResult'],
      })
    );
  });
});
