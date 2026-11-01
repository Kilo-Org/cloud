import { type PreparationAttempt, type PreparationStepSnapshot } from '@kilocode/cloud-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  failedStageStep,
  findRestoreIncompleteStep,
  incompleteRestoreText,
  preparationGroupExpandedByDefault,
} from './preparation-group-state';

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

const INCOMPLETE_STEP = step({
  id: 'incomplete',
  key: 'restore_incomplete',
  label: 'Session restore incomplete',
  status: 'failed',
  safeError:
    'Session restore incomplete: 2 of 5 files were not restored (binary file). Missing: a.ts, b.ts',
});

describe('findRestoreIncompleteStep', () => {
  it('finds the named step among the attempt steps', () => {
    const candidate = attempt({ steps: [step({ id: 'restore' }), INCOMPLETE_STEP] });
    expect(findRestoreIncompleteStep(candidate)).toBe(INCOMPLETE_STEP);
  });

  it('returns undefined when the attempt carries no incomplete-restore step', () => {
    expect(findRestoreIncompleteStep(attempt({ steps: [step({})] }))).toBeUndefined();
  });
});

describe('incompleteRestoreText', () => {
  it('surfaces the step error text from a completed attempt', () => {
    const candidate = attempt({ status: 'completed', steps: [INCOMPLETE_STEP] });
    expect(incompleteRestoreText(candidate)).toBe(INCOMPLETE_STEP.safeError);
  });

  it('surfaces the step error text while the attempt is still running', () => {
    const candidate = attempt({ steps: [INCOMPLETE_STEP] });
    expect(incompleteRestoreText(candidate)).toBe(INCOMPLETE_STEP.safeError);
  });

  it('falls back to the step label when it carries no safe error', () => {
    const candidate = attempt({
      status: 'completed',
      steps: [step({ key: 'restore_incomplete', label: 'Session restore incomplete' })],
    });
    expect(incompleteRestoreText(candidate)).toBe('Session restore incomplete');
  });

  it('returns undefined for a completed attempt without the step', () => {
    expect(incompleteRestoreText(attempt({ status: 'completed' }))).toBeUndefined();
  });

  it('lets a terminal failure outrank the incomplete step', () => {
    const candidate = attempt({
      status: 'failed',
      safeError: 'Setup command failed',
      steps: [INCOMPLETE_STEP],
    });
    expect(incompleteRestoreText(candidate)).toBeUndefined();
  });
});

describe('failedStageStep', () => {
  it('names the phase that failed on a failed attempt', () => {
    const failed = step({ id: 'boot', key: 'sandbox_boot', status: 'failed' });
    const candidate = attempt({ status: 'failed', steps: [step({ id: 'setup' }), failed] });
    expect(failedStageStep(candidate)).toBe(failed);
  });

  it('prefers the failed setup command over the phase it ran under', () => {
    const phase = step({ id: 'commands', key: 'setup_commands', status: 'failed' });
    const command = step({
      id: 'command',
      key: 'setup_commands',
      kind: 'setup_command',
      status: 'failed',
    });
    expect(failedStageStep(attempt({ status: 'failed', steps: [phase, command] }))).toBe(command);
  });

  it('skips the setup-command phase when no command under it failed', () => {
    const candidate = attempt({
      status: 'failed',
      steps: [step({ id: 'commands', key: 'setup_commands', status: 'failed' })],
    });
    expect(failedStageStep(candidate)).toBeUndefined();
  });

  it('does not count the incomplete-restore report as a failed stage', () => {
    const candidate = attempt({
      status: 'failed',
      safeError: 'preparation_timeout',
      steps: [INCOMPLETE_STEP],
    });
    expect(failedStageStep(candidate)).toBeUndefined();
  });

  it('returns undefined unless the attempt itself failed', () => {
    const candidate = attempt({ steps: [step({ status: 'failed' })] });
    expect(failedStageStep(candidate)).toBeUndefined();
  });
});

describe('preparationGroupExpandedByDefault', () => {
  it('opens every unfinished attempt', () => {
    expect(preparationGroupExpandedByDefault(attempt({ status: 'running' }))).toBe(true);
  });

  it('keeps a completed attempt collapsed without the incomplete step', () => {
    expect(preparationGroupExpandedByDefault(attempt({ status: 'completed' }))).toBe(false);
  });

  it('opens a completed attempt that carries the incomplete step', () => {
    const candidate = attempt({ status: 'completed', steps: [INCOMPLETE_STEP] });
    expect(preparationGroupExpandedByDefault(candidate)).toBe(true);
  });
});
