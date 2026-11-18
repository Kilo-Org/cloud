import type { PreparationAttempt, PreparationStepSnapshot } from '@kilocode/cloud-agent-sdk';
import { describeFailedCommand, failedCommandRows } from './failed-commands';

function step(overrides: Partial<PreparationStepSnapshot>): PreparationStepSnapshot {
  return {
    id: 'step-1',
    key: 'workspace_setup',
    kind: 'phase',
    label: 'workspace setup',
    status: 'running',
    startedAt: 1000,
    revision: 1,
    ...overrides,
  };
}

function attempt(steps: PreparationStepSnapshot[]): PreparationAttempt {
  return {
    id: 'attempt-1',
    triggerMessageId: 'message-1',
    status: 'completed',
    startedAt: 1000,
    revision: 1,
    steps,
  };
}

describe('failedCommandRows', () => {
  it('reports failed session setup and start commands with their own phase kind', () => {
    const sessionPhase = step({ id: 'session', key: 'session_setup_commands' });
    const startPhase = step({ id: 'start', key: 'start_commands' });
    const sessionCommand = step({
      id: 'session-command',
      kind: 'setup_command',
      parentStepId: sessionPhase.id,
      commandIndex: 0,
      commandCount: 2,
      command: 'pnpm install',
      status: 'failed',
      exitCode: 1,
      safeError: 'Session setup command 1 failed',
    });
    const startCommand = step({
      id: 'start-command',
      kind: 'setup_command',
      parentStepId: startPhase.id,
      commandIndex: 1,
      commandCount: 2,
      command: 'pnpm dev:start',
      status: 'failed',
      safeError: 'Start command 2 timed out',
    });

    expect(
      failedCommandRows(attempt([sessionPhase, startPhase, sessionCommand, startCommand]))
    ).toEqual([
      {
        attemptId: 'attempt-1',
        stepId: 'session-command',
        kind: 'session_setup',
        commandIndex: 0,
        commandCount: 2,
        command: 'pnpm install',
        exitCode: 1,
        timedOut: false,
      },
      {
        attemptId: 'attempt-1',
        stepId: 'start-command',
        kind: 'start',
        commandIndex: 1,
        commandCount: 2,
        command: 'pnpm dev:start',
        timedOut: true,
      },
    ]);
  });

  it('does not report a failed build command, which fails preparation itself', () => {
    const buildPhase = step({ id: 'build', key: 'setup_commands' });
    const buildCommand = step({
      id: 'build-command',
      kind: 'setup_command',
      parentStepId: buildPhase.id,
      status: 'failed',
      exitCode: 1,
    });

    expect(failedCommandRows(attempt([buildPhase, buildCommand]))).toEqual([]);
  });

  it('ignores a failed command without an owning non-fatal phase', () => {
    expect(
      failedCommandRows(attempt([step({ id: 'command', kind: 'setup_command', status: 'failed' })]))
    ).toEqual([]);
  });
});

describe('describeFailedCommand', () => {
  it('names the command, its position and its exit code', () => {
    expect(
      describeFailedCommand({
        attemptId: 'attempt-1',
        stepId: 'command',
        kind: 'start',
        commandIndex: 0,
        commandCount: 2,
        command: 'pnpm dev:start',
        exitCode: 1,
        timedOut: false,
      })
    ).toBe('Start command 1 of 2 (`pnpm dev:start`) exited 1');
  });

  it('reports a timeout instead of a missing exit code', () => {
    expect(
      describeFailedCommand({
        attemptId: 'attempt-1',
        stepId: 'command',
        kind: 'session_setup',
        commandIndex: 2,
        command: 'pnpm install',
        timedOut: true,
      })
    ).toBe('Session setup command 3 (`pnpm install`) timed out');
  });
});
