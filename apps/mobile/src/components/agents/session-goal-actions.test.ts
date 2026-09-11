import { describe, expect, it } from 'vitest';

import { type SessionGoal, type SessionGoalStatus } from '@kilocode/cloud-agent-sdk';

import { goalCommandArguments, resolveGoalActions } from './session-goal-actions';

function goal(status: SessionGoalStatus): SessionGoal {
  return { text: 'Ship the release', status };
}

describe('resolveGoalActions', () => {
  it('offers edit, pause, and remove for an active goal', () => {
    expect(resolveGoalActions(goal('active'))).toEqual(['edit', 'pause', 'remove']);
  });

  it('offers edit, resume, and remove for a paused goal', () => {
    expect(resolveGoalActions(goal('paused'))).toEqual(['edit', 'resume', 'remove']);
  });

  it('offers only edit and remove for a complete goal', () => {
    expect(resolveGoalActions(goal('complete'))).toEqual(['edit', 'remove']);
  });

  it('offers only edit and remove for a blocked goal', () => {
    expect(resolveGoalActions(goal('blocked'))).toEqual(['edit', 'remove']);
  });
});

describe('goalCommandArguments', () => {
  it('sends the objective for edit', () => {
    expect(goalCommandArguments('edit', 'Ship the release')).toBe('Ship the release');
  });

  it('maps pause to the CLI pause argument', () => {
    expect(goalCommandArguments('pause', 'Ship the release')).toBe('pause');
  });

  it('maps resume to the CLI resume argument', () => {
    expect(goalCommandArguments('resume', 'Ship the release')).toBe('resume');
  });

  it('maps remove to the CLI clear argument', () => {
    expect(goalCommandArguments('remove', 'Ship the release')).toBe('clear');
  });
});
