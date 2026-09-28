import { describe, expect, it } from 'bun:test';
import { autoCommitRecordSchema } from '@kilocode/worker-utils/cloud-agent-commits';
import {
  MAX_SANDBOX_CONTROL_FRAME_BYTES,
  sessionOperationDeliverySchema,
  type SessionOperationAuthorization,
  type SessionEventPayload,
  type SessionPreparingPayload,
} from '../../../src/shared/sandbox-control-protocol.js';
import type { PreparingEventDataV2 } from '../../../src/shared/protocol.js';
import { MAX_COMMIT_MESSAGE_BYTES } from '../commit-objects.js';
import { createRetainedOperationNotifications } from './retained-operation-notifications.js';

function authorization(
  operation: SessionOperationAuthorization['operation'] = 'session.attach'
): SessionOperationAuthorization {
  return {
    operation,
    operationId: operation === 'session.prompt' ? 'msg_1' : 'prepare_msg_1',
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

function finalization(properties: Record<string, unknown>): SessionEventPayload {
  return {
    type: 'autocommit_completed',
    properties,
    timestamp: '2026-09-01T00:00:00.000Z',
  };
}

function validFinalization(overrides: Record<string, unknown> = {}): SessionEventPayload {
  return finalization({
    success: true,
    messageId: 'assistant_1',
    userMessageId: 'user_1',
    commitHash: 'a'.repeat(40),
    committedAt: '2026-09-01T12:34:56.789+02:00',
    pushStatus: 'unknown',
    commitMessage: 'Apply changes\n',
    ...overrides,
  });
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
  it('retains every field from a complete finalization record', () => {
    const recorder = createRetainedOperationNotifications();
    const retained = recorder.retainFinalization(
      validFinalization({
        skipped: false,
        message: 'Changes committed',
        commitMessageTruncated: true,
        unknownField: 'drop me',
      })
    );

    expect(retained).toEqual({
      type: 'autocommit_completed',
      properties: {
        success: true,
        messageId: 'assistant_1',
        skipped: false,
        commitHash: 'a'.repeat(40),
        message: 'Changes committed',
        userMessageId: 'user_1',
        committedAt: '2026-09-01T12:34:56.789+02:00',
        pushStatus: 'unknown',
        commitMessage: 'Apply changes\n',
        commitMessageTruncated: true,
      },
      timestamp: '2026-09-01T00:00:00.000Z',
    });
    if (!retained) throw new Error('Missing retained finalization');
    expect(autoCommitRecordSchema.parse(retained.properties)).toEqual({
      commitHash: 'a'.repeat(40),
      commitMessage: 'Apply changes\n',
      userMessageId: 'user_1',
      messageId: 'assistant_1',
      committedAt: '2026-09-01T12:34:56.789+02:00',
      pushStatus: 'unknown',
      commitMessageTruncated: true,
    });
  });

  it.each([
    [
      'an exact UTF-8 byte boundary',
      'é'.repeat(MAX_COMMIT_MESSAGE_BYTES / 2),
      'é'.repeat(MAX_COMMIT_MESSAGE_BYTES / 2),
      false,
    ],
    [
      'one byte over the UTF-8 byte boundary',
      'é'.repeat(MAX_COMMIT_MESSAGE_BYTES / 2) + 'a',
      'é'.repeat(MAX_COMMIT_MESSAGE_BYTES / 2),
      true,
    ],
    [
      'a four-byte code point over the boundary',
      'a'.repeat(MAX_COMMIT_MESSAGE_BYTES - 2) + '😀',
      'a'.repeat(MAX_COMMIT_MESSAGE_BYTES - 2),
      true,
    ],
    [
      'a surrogate pair at the truncation boundary',
      'a'.repeat(MAX_COMMIT_MESSAGE_BYTES - 1) + '😀',
      'a'.repeat(MAX_COMMIT_MESSAGE_BYTES - 1),
      true,
    ],
  ] as const)('projects commit messages at %s', (_name, input, expected, truncated) => {
    const recorder = createRetainedOperationNotifications();
    const retained = recorder.retainFinalization(validFinalization({ commitMessage: input }));
    expect(retained).toBeDefined();
    if (!retained) throw new Error('Missing retained finalization');

    expect(retained.properties.commitMessage).toBe(expected);
    expect(Buffer.byteLength(String(retained.properties.commitMessage))).toBeLessThanOrEqual(
      MAX_COMMIT_MESSAGE_BYTES
    );
    const parsed = autoCommitRecordSchema.parse(retained.properties);
    expect(parsed.commitMessage).toBe(expected);
    expect(parsed.commitMessageTruncated).toBe(truncated ? true : undefined);
  });

  it('retains a maximum valid finalization record within the delivery budget', () => {
    const recorder = createRetainedOperationNotifications();
    recorder.retainFinalization(
      validFinalization({
        messageId: 'msg_1',
        userMessageId: 'u'.repeat(256),
        commitHash: 'b'.repeat(64),
        committedAt: '2026-09-01T12:34:56.789-07:00',
        pushStatus: 'pushed',
        commitMessage: 'é'.repeat(MAX_COMMIT_MESSAGE_BYTES / 2),
        commitMessageTruncated: true,
        skipped: true,
        message: 'm'.repeat(4_096),
        unknownField: { ignored: true },
      })
    );
    const snapshot = recorder.snapshot();

    expect(snapshot.events).toHaveLength(1);
    expect(retainedBytes(snapshot)).toBeLessThanOrEqual(
      Math.floor(MAX_SANDBOX_CONTROL_FRAME_BYTES / 2)
    );
    const wire = {
      version: 2 as const,
      authorization: authorization('session.prompt'),
      completedAt: Date.now(),
      result: { ok: true as const, result: { prompted: true } },
      outcome: { messageId: 'msg_1', status: 'completed' as const },
      events: snapshot.events,
      preparing: snapshot.preparing,
    };
    expect(sessionOperationDeliverySchema.parse(wire)).toEqual(wire);
  });

  it('retains the valid-hash minimal legacy projection', () => {
    const recorder = createRetainedOperationNotifications();
    const retained = recorder.retainFinalization(
      finalization({
        success: true,
        messageId: 'assistant_1',
        commitHash: 'c'.repeat(40),
        unknownField: 'drop me',
      })
    );

    expect(retained).toEqual({
      type: 'autocommit_completed',
      properties: { success: true, messageId: 'assistant_1', commitHash: 'c'.repeat(40) },
      timestamp: '2026-09-01T00:00:00.000Z',
    });
  });

  it.each([
    [
      'an unsupported event type',
      {
        type: 'autocommit_started',
        properties: { success: true, messageId: 'assistant_1' },
        timestamp: '2026-09-01T00:00:00.000Z',
      },
    ],
    ['a finalization without success', finalization({ messageId: 'assistant_1' })],
    [
      'a finalization with non-boolean success',
      finalization({ success: 'true', messageId: 'assistant_1' }),
    ],
  ] as const)('rejects %s', (_name, payload) => {
    const recorder = createRetainedOperationNotifications();
    expect(recorder.retainFinalization(payload)).toBeUndefined();
  });

  it('keeps status messages bounded to 4096 characters', () => {
    const recorder = createRetainedOperationNotifications();
    const retained = recorder.retainFinalization({
      type: 'status',
      properties: {
        message: 's'.repeat(5_000),
        messageId: 'assistant_1',
        unknownField: 'drop me',
      },
      timestamp: '2026-09-01T00:00:00.000Z',
    });

    expect(retained).toEqual({
      type: 'status',
      properties: { message: 's'.repeat(4_096), messageId: 'assistant_1' },
      timestamp: '2026-09-01T00:00:00.000Z',
    });
  });

  it.each([
    ['malformed hash', { commitHash: 'not-a-hash' }, 'commitHash'],
    ['overlong hash', { commitHash: 'a'.repeat(65) }, 'commitHash'],
    ['empty user anchor', { userMessageId: '' }, 'userMessageId'],
    ['overlong user anchor', { userMessageId: 'u'.repeat(257) }, 'userMessageId'],
    ['garbage committedAt', { committedAt: 'not-a-timestamp' }, 'committedAt'],
    ['overlong committedAt', { committedAt: 't'.repeat(129) }, 'committedAt'],
    ['non-enum push status', { pushStatus: 'retrying' }, 'pushStatus'],
    ['invalid truncation marker', { commitMessageTruncated: false }, 'commitMessageTruncated'],
  ] as const)('omits %s without invalidating the other projection', (_name, override, field) => {
    const recorder = createRetainedOperationNotifications();
    const retained = recorder.retainFinalization(validFinalization(override));
    expect(retained).toBeDefined();
    if (!retained) throw new Error('Missing retained finalization');
    expect(retained.properties).not.toHaveProperty(field);
    const expectedSurvivors = {
      success: true,
      messageId: 'assistant_1',
      userMessageId: 'user_1',
      commitHash: 'a'.repeat(40),
      committedAt: '2026-09-01T12:34:56.789+02:00',
      pushStatus: 'unknown',
      commitMessage: 'Apply changes\n',
    };
    for (const [key, value] of Object.entries(expectedSurvivors)) {
      if (key !== field) expect(retained.properties[key]).toBe(value);
    }
  });

  it.each([
    ['empty', ''],
    ['overlong', 'm'.repeat(257)],
    ['missing', undefined],
  ] as const)('rejects a %s required messageId', (_name, messageId) => {
    const recorder = createRetainedOperationNotifications();
    expect(recorder.retainFinalization(validFinalization({ messageId }))).toBeUndefined();
  });

  it.each(autoCommitRecordSchema.shape.pushStatus.options)(
    'retains shared-schema push status %s',
    pushStatus => {
      const recorder = createRetainedOperationNotifications();
      const retained = recorder.retainFinalization(validFinalization({ pushStatus }));
      expect(retained).toBeDefined();
      if (!retained) throw new Error('Missing retained finalization');
      expect(retained.properties.pushStatus).toBe(pushStatus);
      expect(autoCommitRecordSchema.parse(retained.properties).pushStatus).toBe(pushStatus);
    }
  );

  it('reserves capacity for an attempt terminal after optional updates', () => {
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
    expect(terminal).toBeDefined();
    expect(after.preparing.length - before.preparing.length).toBe(1);
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
