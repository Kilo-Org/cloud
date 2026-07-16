import type { PreparationStepSnapshot } from '@/lib/cloud-agent-sdk';
import {
  formatAttemptDuration,
  humanizePhaseLabel,
  phaseStatus,
  phaseStatusLabel,
} from './preparation-phases';

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

describe('humanizePhaseLabel', () => {
  it('replaces underscores and capitalizes the first letter', () => {
    expect(humanizePhaseLabel(step({ label: 'disk_check' }))).toBe('Disk check');
    expect(humanizePhaseLabel(step({ label: 'workspace setup' }))).toBe('Workspace setup');
  });
});

describe('phaseStatus', () => {
  it('reports the step status for regular phases', () => {
    expect(phaseStatus(step({ status: 'completed' }), [])).toBe('completed');
    expect(phaseStatus(step({ status: 'failed' }), [])).toBe('failed');
  });

  it('derives the setup_commands phase status from the command steps', () => {
    const phase = step({ key: 'setup_commands', label: 'setup commands' });
    const completed = step({ kind: 'setup_command', status: 'completed' });
    const failed = step({ kind: 'setup_command', status: 'failed' });
    const running = step({ kind: 'setup_command', status: 'running' });
    expect(phaseStatus(phase, [completed])).toBe('completed');
    expect(phaseStatus(phase, [completed, running])).toBe('running');
    expect(phaseStatus(phase, [completed, failed])).toBe('failed');
  });

  it('falls back to the step status for setup_commands without observed commands', () => {
    expect(phaseStatus(step({ key: 'setup_commands', status: 'running' }), [])).toBe('running');
  });
});

describe('formatAttemptDuration', () => {
  it('returns undefined while the attempt is still running', () => {
    expect(formatAttemptDuration({ startedAt: 1000 })).toBeUndefined();
  });

  it('formats sub-minute durations as seconds', () => {
    expect(formatAttemptDuration({ startedAt: 1000, completedAt: 13_400 })).toBe('12s');
  });

  it('formats longer durations as minutes and seconds', () => {
    expect(formatAttemptDuration({ startedAt: 0, completedAt: 125_000 })).toBe('2m 5s');
  });

  it('clamps a clock skew to zero', () => {
    expect(formatAttemptDuration({ startedAt: 5000, completedAt: 4000 })).toBe('0s');
  });
});

describe('phaseStatusLabel', () => {
  it('maps each status to a screen-reader label', () => {
    expect(phaseStatusLabel('running')).toBe('Running');
    expect(phaseStatusLabel('completed')).toBe('Completed');
    expect(phaseStatusLabel('failed')).toBe('Failed');
  });
});
