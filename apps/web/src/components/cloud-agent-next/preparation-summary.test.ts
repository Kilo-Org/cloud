import type { PreparationAttempt, PreparationStepSnapshot } from '@kilocode/cloud-agent-sdk';
import {
  extractTickerLines,
  findRunningSetupCommand,
  preparationSummaryLine,
  summarizePreparationAttempt,
} from './preparation-summary';

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

function attempt(overrides: Partial<PreparationAttempt>): PreparationAttempt {
  return {
    id: 'attempt-1',
    triggerMessageId: 'message-1',
    status: 'running',
    startedAt: 1000,
    revision: 1,
    steps: [],
    ...overrides,
  };
}

describe('summarizePreparationAttempt', () => {
  it('reports starting while no step is running yet', () => {
    expect(summarizePreparationAttempt(attempt({}))).toEqual({ kind: 'starting' });
    const completedOnly = attempt({ steps: [step({ status: 'completed' })] });
    expect(summarizePreparationAttempt(completedOnly)).toEqual({ kind: 'starting' });
  });

  it('shows the running phase progress message when one was reported', () => {
    const running = attempt({
      steps: [step({ key: 'disk_check', label: 'disk_check', latestDetail: 'Checking disk…' })],
    });
    expect(summarizePreparationAttempt(running)).toEqual({
      kind: 'phase',
      text: 'Checking disk…',
    });
  });

  it('falls back to the humanized phase label without a progress message', () => {
    const running = attempt({ steps: [step({ key: 'disk_check', label: 'disk_check' })] });
    expect(summarizePreparationAttempt(running)).toEqual({ kind: 'phase', text: 'Disk check' });
  });

  it('prefers a running setup command over a running phase', () => {
    const running = attempt({
      steps: [
        step({ id: 'phase', key: 'setup_commands', label: 'setup commands' }),
        step({
          id: 'command',
          kind: 'setup_command',
          key: 'setup_command:1',
          command: 'npm install',
          commandIndex: 1,
          commandCount: 3,
        }),
      ],
    });
    expect(summarizePreparationAttempt(running)).toEqual({
      kind: 'command',
      command: 'npm install',
      commandIndex: 1,
      commandCount: 3,
    });
  });

  it('falls back to the step label when a command has no command string', () => {
    const running = attempt({
      steps: [step({ kind: 'setup_command', label: 'setup command 1' })],
    });
    expect(summarizePreparationAttempt(running)).toEqual({
      kind: 'command',
      command: 'setup command 1',
      commandIndex: undefined,
      commandCount: undefined,
    });
  });

  it('reports the duration for a completed attempt', () => {
    const completed = attempt({ status: 'completed', completedAt: 13_400 });
    expect(summarizePreparationAttempt(completed)).toEqual({ kind: 'completed', duration: '12s' });
  });

  it('surfaces an incomplete restore from a completed attempt', () => {
    const completed = attempt({
      status: 'completed',
      completedAt: 13_400,
      steps: [
        step({ id: 'restore', status: 'completed' }),
        step({
          id: 'incomplete',
          key: 'restore_incomplete',
          label: 'Session restore incomplete',
          status: 'failed',
          safeError:
            'Session restore incomplete: 2 of 5 files were not restored (binary file). Missing: a.ts, b.ts',
        }),
      ],
    });
    expect(summarizePreparationAttempt(completed)).toEqual({
      kind: 'incomplete',
      text: 'Session restore incomplete: 2 of 5 files were not restored (binary file). Missing: a.ts, b.ts',
    });
  });

  it('surfaces an incomplete restore while the attempt is still running', () => {
    const running = attempt({
      steps: [
        step({
          id: 'incomplete',
          key: 'restore_incomplete',
          label: 'Session restore incomplete',
          status: 'failed',
          safeError:
            'Session restore incomplete: 1 of 3 files were not restored (timeout). Missing: c.ts',
        }),
      ],
    });
    expect(summarizePreparationAttempt(running)).toEqual({
      kind: 'incomplete',
      text: 'Session restore incomplete: 1 of 3 files were not restored (timeout). Missing: c.ts',
    });
  });

  it('falls back to the incomplete step label when it carries no safe error', () => {
    const completed = attempt({
      status: 'completed',
      steps: [
        step({
          id: 'incomplete',
          key: 'restore_incomplete',
          label: 'Session restore incomplete',
          status: 'failed',
          safeError: undefined,
        }),
      ],
    });
    expect(summarizePreparationAttempt(completed)).toEqual({
      kind: 'incomplete',
      text: 'Session restore incomplete',
    });
  });

  it('reports no duration for a completed attempt without completedAt', () => {
    const completed = attempt({ status: 'completed' });
    expect(summarizePreparationAttempt(completed)).toEqual({
      kind: 'completed',
      duration: undefined,
    });
  });

  it('surfaces the attempt error for a failed attempt', () => {
    const failed = attempt({ status: 'failed', safeError: 'clone failed' });
    expect(summarizePreparationAttempt(failed)).toEqual({ kind: 'failed', error: 'clone failed' });
  });

  it('falls back to the last failed step error, then to none', () => {
    const failed = attempt({
      status: 'failed',
      steps: [
        step({ id: 'a', status: 'failed', safeError: 'first error' }),
        step({ id: 'b', status: 'failed', safeError: 'second error' }),
      ],
    });
    expect(summarizePreparationAttempt(failed)).toEqual({ kind: 'failed', error: 'second error' });
    expect(summarizePreparationAttempt(attempt({ status: 'failed' }))).toEqual({
      kind: 'failed',
      error: undefined,
    });
  });

  it('reports a terminal failure ahead of the incomplete restore step', () => {
    const failed = attempt({
      status: 'failed',
      safeError: 'Setup command failed',
      steps: [
        step({
          id: 'incomplete',
          key: 'restore_incomplete',
          label: 'Session restore incomplete',
          status: 'failed',
          safeError: 'Session restore incomplete: 2 of 5 files were not restored (binary file)',
        }),
      ],
    });
    expect(summarizePreparationAttempt(failed)).toEqual({
      kind: 'failed',
      error: 'Setup command failed',
    });
  });

  it('falls back to the incomplete step error when a failed attempt carries no safe error', () => {
    const failed = attempt({
      status: 'failed',
      safeError: undefined,
      steps: [
        step({
          id: 'incomplete',
          key: 'restore_incomplete',
          label: 'Session restore incomplete',
          status: 'failed',
          safeError:
            'Session restore incomplete: 2 of 5 files were not restored (outside_workspace)',
        }),
      ],
    });
    expect(summarizePreparationAttempt(failed)).toEqual({
      kind: 'failed',
      error: 'Session restore incomplete: 2 of 5 files were not restored (outside_workspace)',
    });
  });

  it('reports a failed attempt with no safe error and no step error', () => {
    const failed = attempt({
      status: 'failed',
      safeError: undefined,
      steps: [
        step({
          id: 'incomplete',
          key: 'restore_incomplete',
          label: 'Session restore incomplete',
          status: 'failed',
          safeError: undefined,
        }),
      ],
    });
    expect(summarizePreparationAttempt(failed)).toEqual({ kind: 'failed' });
  });
});

describe('preparationSummaryLine', () => {
  it('shows the incomplete-restore text instead of "Environment prepared"', () => {
    const completed = attempt({
      status: 'completed',
      completedAt: 13_400,
      steps: [
        step({ id: 'restore', status: 'completed' }),
        step({
          id: 'incomplete',
          key: 'restore_incomplete',
          label: 'Session restore incomplete',
          status: 'failed',
          safeError:
            'Session restore incomplete: 2 of 5 files were not restored (binary file). Missing: a.ts, b.ts',
        }),
      ],
    });
    expect(preparationSummaryLine(completed)).toBe(
      'Session restore incomplete: 2 of 5 files were not restored (binary file). Missing: a.ts, b.ts · 12s'
    );
  });

  it('shows the incomplete text for a still-running attempt without a duration', () => {
    const running = attempt({
      steps: [
        step({
          id: 'incomplete',
          key: 'restore_incomplete',
          label: 'Session restore incomplete',
          status: 'failed',
          safeError: 'Session restore incomplete: 1 of 3 files were not restored (timeout)',
        }),
      ],
    });
    expect(preparationSummaryLine(running)).toBe(
      'Session restore incomplete: 1 of 3 files were not restored (timeout)'
    );
  });

  it('reports the completed summary for an attempt without an incomplete step', () => {
    expect(preparationSummaryLine(attempt({ status: 'completed', completedAt: 13_400 }))).toBe(
      'Environment prepared · 12s'
    );
  });

  it('reports a preparing summary while the attempt runs', () => {
    expect(preparationSummaryLine(attempt({}))).toBe('Preparing environment');
  });

  it('reports a failed summary for a failed attempt', () => {
    expect(
      preparationSummaryLine(attempt({ status: 'failed', completedAt: 13_400, safeError: 'boom' }))
    ).toBe('Preparation failed · 12s');
  });
});

describe('findRunningSetupCommand', () => {
  it('returns the running command, ignoring phases and finished commands', () => {
    const running = step({ id: 'running', kind: 'setup_command' });
    const candidate = attempt({
      steps: [
        step({ id: 'phase' }),
        step({ id: 'done', kind: 'setup_command', status: 'completed' }),
        running,
      ],
    });
    expect(findRunningSetupCommand(candidate)).toBe(running);
  });

  it('returns undefined when no command is running', () => {
    const candidate = attempt({
      steps: [step({}), step({ id: 'done', kind: 'setup_command', status: 'completed' })],
    });
    expect(findRunningSetupCommand(candidate)).toBeUndefined();
  });
});

describe('extractTickerLines', () => {
  it('returns no lines for missing or empty output', () => {
    expect(extractTickerLines(undefined)).toEqual([]);
    expect(extractTickerLines('')).toEqual([]);
  });

  it('returns all lines when there are fewer than the maximum', () => {
    expect(extractTickerLines('one\ntwo')).toEqual(['one', 'two']);
  });

  it('returns only the trailing lines when there are more', () => {
    expect(extractTickerLines('1\n2\n3\n4\n5')).toEqual(['3', '4', '5']);
    expect(extractTickerLines('1\n2\n3', 2)).toEqual(['2', '3']);
  });

  it('ignores a trailing newline and normalizes CRLF', () => {
    expect(extractTickerLines('one\r\ntwo\n')).toEqual(['one', 'two']);
  });

  it('preserves blank interior lines', () => {
    expect(extractTickerLines('one\n\ntwo')).toEqual(['one', '', 'two']);
  });
});
