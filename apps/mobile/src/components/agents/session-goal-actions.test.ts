import { describe, expect, it } from 'vitest';

import {
  type SessionGoal,
  type SessionGoalStatus,
  type SessionInfo,
} from '@kilocode/cloud-agent-sdk';

import {
  goalClearsBlockingAfterSend,
  goalCommandArguments,
  resolveGoalActions,
  selectVisibleGoal,
} from './session-goal-actions';

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

  it('offers edit, resume, and remove for a complete goal so it can be restarted', () => {
    expect(resolveGoalActions(goal('complete'))).toEqual(['edit', 'resume', 'remove']);
  });

  it('offers edit, resume, and remove for a blocked goal once the blocker is resolved', () => {
    expect(resolveGoalActions(goal('blocked'))).toEqual(['edit', 'resume', 'remove']);
  });
});

describe('goalClearsBlockingAfterSend', () => {
  it('clears a pending request after pause, once the goal has stopped', () => {
    expect(goalClearsBlockingAfterSend('pause')).toBe(true);
  });

  it('clears a pending request after remove, once the goal has stopped', () => {
    expect(goalClearsBlockingAfterSend('remove')).toBe(true);
  });

  it('clears a pending request before resume, which the CLI rejects while blocked', () => {
    expect(goalClearsBlockingAfterSend('resume')).toBe(false);
  });

  it('clears a pending request before edit, which the CLI rejects while blocked', () => {
    expect(goalClearsBlockingAfterSend('edit')).toBe(false);
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

describe('selectVisibleGoal', () => {
  const paused = goal('paused');

  it('returns the goal for a live session that reports one', () => {
    const info: SessionInfo = { id: 'ses_live', goal: paused };
    expect(selectVisibleGoal(info, false)).toEqual(paused);
  });

  it('hides the goal for a read-only session even when its snapshot carries one', () => {
    const info: SessionInfo = { id: 'ses_read_only', goal: paused };
    expect(selectVisibleGoal(info, true)).toBeNull();
  });

  it('returns null when the session has no goal', () => {
    expect(selectVisibleGoal({ id: 'ses_plain' }, false)).toBeNull();
    expect(selectVisibleGoal(null, false)).toBeNull();
  });
});
