import { describe, expect, it } from 'bun:test';
import {
  MAX_SANDBOX_CONTROL_FRAME_BYTES,
  sessionOperationDeliverySchema,
  type SessionOperationAuthorization,
  type SessionPreparingPayload,
} from '../../../src/shared/sandbox-control-protocol.js';
import type { PreparingEventDataV2 } from '../../../src/shared/protocol.js';
import { createRetainedOperationNotifications } from './retained-operation-notifications.js';

function authorization(): SessionOperationAuthorization {
  return {
    operation: 'session.attach',
    operationId: 'prepare_msg_1',
    messageId: 'msg_1',
    session: {
      sessionId: 'ses_1',
      kiloSessionId: 'kilo_1',
      directory: '/workspace',
    },
    wrapperInstanceId: '00000000-0000-4000-8000-000000000000',
    dispatchDeadlineAt: Date.now() + 60_000,
  };
}

function delivery(preparing: SessionPreparingPayload[]) {
  return {
    version: 2 as const,
    authorization: authorization(),
    completedAt: Date.now(),
    result: { ok: true as const, result: { attached: true } },
    events: [],
    preparing,
  };
}

function retainedBytes(
  snapshot: ReturnType<ReturnType<typeof createRetainedOperationNotifications>['snapshot']>
) {
  return [...snapshot.events, ...snapshot.preparing].reduce(
    (total, payload) => total + Buffer.byteLength(JSON.stringify(payload)),
    0
  );
}

function optionalStep(revision: number, message: string, metadata: string): PreparingEventDataV2 {
  return {
    version: 2,
    attemptId: 'prepare_msg_1',
    triggerMessageId: 'msg_1',
    revision,
    timestamp: revision,
    step: 'workspace_setup',
    message,
    action: 'step_started',
    stepId: `step_${revision}`,
    kind: 'phase',
    label: metadata,
    command: metadata,
  };
}

function completedStep(revision: number): PreparingEventDataV2 {
  return {
    version: 2,
    attemptId: 'prepare_msg_1',
    triggerMessageId: 'msg_1',
    revision,
    timestamp: revision,
    step: 'workspace_setup',
    message: `Completed ${revision}`,
    action: 'step_completed',
    stepId: `step_${revision}`,
  };
}

describe('retained operation notifications', () => {
  it('evicts multiple optional entries for a larger valid attempt terminal', () => {
    const recorder = createRetainedOperationNotifications();
    const musicalSymbolGClef = String.fromCodePoint(0x1d11e);
    const message = musicalSymbolGClef.repeat(900);
    const metadata = 'm'.repeat(3_000);
    let retained = 0;
    for (let revision = 0; revision < 64; revision++) {
      if (!recorder.retainPreparing(optionalStep(revision, message, metadata))) break;
      retained++;
    }
    const before = recorder.snapshot();
    const terminalText = musicalSymbolGClef.repeat(2_048);
    const terminal = recorder.retainPreparing({
      version: 2,
      attemptId: 'prepare_msg_1',
      triggerMessageId: 'msg_1',
      revision: retained,
      timestamp: retained,
      step: 'workspace_setup',
      message: terminalText,
      action: 'attempt_failed',
      safeError: terminalText,
    });
    const after = recorder.snapshot();

    expect(retained).toBeGreaterThan(1);
    expect(retainedBytes(before)).toBeGreaterThan(
      Math.floor(MAX_SANDBOX_CONTROL_FRAME_BYTES / 2) * 0.99
    );
    expect(terminal).toBeDefined();
    expect(before.preparing.length - after.preparing.length).toBe(1);
    expect(after.events).toHaveLength(0);
    expect(after.preparing.length).toBeLessThanOrEqual(64);
    expect(retainedBytes(after)).toBeLessThanOrEqual(
      Math.floor(MAX_SANDBOX_CONTROL_FRAME_BYTES / 2)
    );
    expect(after.preparing).toContainEqual(
      expect.objectContaining({ action: 'attempt_failed', safeError: terminalText })
    );
    const wire = delivery(after.preparing);
    expect(sessionOperationDeliverySchema.parse(wire)).toEqual(wire);
  });

  it.each(['attempt_completed', 'attempt_failed'] as const)(
    'reserves a final slot after 64 completed steps for %s',
    action => {
      const recorder = createRetainedOperationNotifications();
      for (let revision = 0; revision < 64; revision++)
        recorder.retainPreparing(completedStep(revision));
      const terminal =
        action === 'attempt_failed'
          ? recorder.retainPreparing({
              version: 2,
              attemptId: 'prepare_msg_1',
              triggerMessageId: 'msg_1',
              revision: 64,
              timestamp: 64,
              step: 'workspace_setup',
              message: 'Preparation failed',
              action,
              safeError: 'Command failed',
            })
          : recorder.retainPreparing({
              version: 2,
              attemptId: 'prepare_msg_1',
              triggerMessageId: 'msg_1',
              revision: 64,
              timestamp: 64,
              step: 'workspace_setup',
              message: 'Preparation completed',
              action,
            });
      const snapshot = recorder.snapshot();

      expect(terminal).toBeDefined();
      expect(snapshot.preparing).toHaveLength(64);
      expect(snapshot.preparing.filter(event => event.action === 'step_completed')).toHaveLength(
        63
      );
      expect(snapshot.preparing).toContainEqual(expect.objectContaining({ action }));
      expect(retainedBytes(snapshot)).toBeLessThanOrEqual(
        Math.floor(MAX_SANDBOX_CONTROL_FRAME_BYTES / 2)
      );
      const wire = delivery(snapshot.preparing);
      expect(sessionOperationDeliverySchema.parse(wire)).toEqual(wire);
    }
  );
});
