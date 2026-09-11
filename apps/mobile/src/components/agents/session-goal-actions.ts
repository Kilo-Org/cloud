import { type SessionGoal } from '@kilocode/cloud-agent-sdk';

/** Goal controls offered by tapping the fixed goal section. */
export type GoalAction = 'edit' | 'pause' | 'resume' | 'remove';

/**
 * Mirrors the CLI goal actions: Pause is offered only while active, Resume
 * only while paused. Edit and Remove are always available.
 */
export function resolveGoalActions(goal: SessionGoal): GoalAction[] {
  const actions: GoalAction[] = ['edit'];
  if (goal.status === 'active') {
    actions.push('pause');
  }
  if (goal.status === 'paused') {
    actions.push('resume');
  }
  actions.push('remove');
  return actions;
}

/** Maps a goal control to the `/goal` command argument the CLI expects. */
export function goalCommandArguments(action: GoalAction, objective: string): string {
  // The `edit` action carries its own objective; the rest map to fixed CLI
  // subcommands. `clear` is the remove action's wire argument.
  if (action === 'edit') {
    return objective;
  }
  if (action === 'pause') {
    return 'pause';
  }
  if (action === 'resume') {
    return 'resume';
  }
  return 'clear';
}
