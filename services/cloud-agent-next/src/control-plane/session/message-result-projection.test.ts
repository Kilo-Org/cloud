import { describe, expect, it, vi } from 'vitest';
import { isTerminalFailureRetryable } from '../../session/terminal-error-projector.js';
import type { PreparationAttempt } from '../../shared/protocol.js';
import { projectMessageResult } from './message-result-projection.js';
import type { SessionMessage } from './messages.js';
import { projectSettledMessageFailure } from './reports.js';
import { setupCommandLabel } from './setup-command-label.js';

const completedMessage = {
  messageId: 'msg_prompt',
  intent: {
    messageId: 'msg_prompt',
    agent: { mode: 'code', model: 'kilo/fake-deterministic' },
    turn: { type: 'prompt', prompt: 'Hello' },
  },
  state: 'completed',
  createdAt: 1,
  acceptedAt: 2,
  settledAt: 3,
  reason: null,
} satisfies SessionMessage;

const resultInput = {
  cloudAgentSessionId: 'workspace_test',
  readAssistantText: () => undefined,
  readPreparation: () => null,
};

describe('projectMessageResult', () => {
  it('reads the stored final answer and includes the gate result and branch', () => {
    const readAssistantText = vi.fn(() => '  final answer\n');
    const result = projectMessageResult({
      ...resultInput,
      message: {
        ...completedMessage,
        settlement: {
          assistantMessageId: 'msg_answer',
          facts: { gateResult: 'pass' },
          branch: 'main',
        },
      },
      readAssistantText,
    });

    expect(readAssistantText).toHaveBeenCalledExactlyOnceWith('msg_answer');
    expect(result).toMatchObject({
      status: 'completed',
      assistant: { messageId: 'msg_answer', text: 'final answer' },
      gateResult: 'pass',
      branch: 'main',
    });
    expect(result.failure).toBeUndefined();

    readAssistantText.mockClear();
    const withoutAnswer = projectMessageResult({
      ...resultInput,
      message: completedMessage,
      readAssistantText,
    });
    expect(withoutAnswer.assistant).toBeUndefined();
    expect(readAssistantText).not.toHaveBeenCalled();
  });

  it.each([
    ['failed', 'workspace_setup_failed', false],
    ['failed', 'workspace_setup_failed', true],
    ['cancelled', 'interrupted', false],
    ['cancelled', 'interrupted', true],
  ] as const)('projects %s (%s) with settlement record: %s', (state, reason, hasSettlement) => {
    const message: SessionMessage = {
      ...completedMessage,
      state,
      reason,
      settlement: hasSettlement
        ? { facts: { workspaceSubtype: 'git_rate_limited' }, branch: 'main' }
        : undefined,
    };
    const projected = projectSettledMessageFailure(message, message.settlement?.facts ?? {});
    if (projected === undefined) throw new Error('Missing settled failure');

    const result = projectMessageResult({ ...resultInput, message });
    expect(result.status).toBe(state === 'cancelled' ? 'interrupted' : 'failed');
    expect(result.failure).toEqual({
      ...projected,
      retryable: isTerminalFailureRetryable({
        failureStage: projected.stage,
        failureCode: projected.code,
      }),
    });
    expect(result.failure?.stage).toBeTruthy();
    expect(result.failure?.code).toBeTruthy();
  });

  it('summarizes the last failed setup step without its command or output', () => {
    const attempt: PreparationAttempt = {
      id: 'attempt_a',
      triggerMessageId: completedMessage.messageId,
      status: 'failed',
      startedAt: 1,
      revision: 3,
      steps: [
        {
          id: 'setup',
          key: 'setup_commands',
          kind: 'phase',
          label: 'Running setup commands',
          status: 'failed',
          startedAt: 1,
          revision: 3,
        },
        {
          id: 'command',
          key: 'setup_commands',
          kind: 'setup_command',
          label: setupCommandLabel('build', 1, 'exit 7'),
          status: 'failed',
          startedAt: 2,
          revision: 2,
          command: 'exit 7',
          exitCode: 7,
          outputTail: 'command output',
          latestDetail: 'command detail',
          safeError: 'workspace_setup_failed',
        },
      ],
    };
    const result = projectMessageResult({
      ...resultInput,
      message: completedMessage,
      readPreparation: () => attempt,
    });
    expect(result.preparation).toEqual({
      status: 'failed',
      failedStepLabel: 'Build command 1',
      reason: 'Workspace setup failed',
    });
    expect(
      projectMessageResult({ ...resultInput, message: completedMessage }).preparation
    ).toBeUndefined();
  });
});
