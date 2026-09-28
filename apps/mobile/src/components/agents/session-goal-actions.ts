import { type SessionGoal, type SessionInfo } from '@kilocode/cloud-agent-sdk';

/** Goal controls offered by tapping the fixed goal section. */
export type GoalAction = 'edit' | 'pause' | 'resume' | 'remove';

/**
 * The fixed goal row is an action surface: tapping it sends `/goal`. A
 * read-only session has no CLI owner to accept that command, yet its
 * historical snapshot can still carry `kilo.goal` metadata (the page
 * transport projects it). Hide the row for read-only sessions so the
 * metadata never turns into controls the session cannot support.
 */
export function selectVisibleGoal(
  info: SessionInfo | null,
  isReadOnly: boolean
): SessionGoal | null {
  if (isReadOnly) {
    return null;
  }
  return info?.goal ?? null;
}

/**
 * The CLI accepts `/goal pause` and `/goal clear` while a question or
 * permission is pending, but the pending request then blocks every later
 * resume. The app clears it *after* the goal has stopped: the CLI records a
 * rejected request as a blocked goal only while the goal is still running, so
 * clearing after pause/clear leaves the goal paused instead of blocked.
 *
 * `/goal resume` and `/goal <objective>` are rejected while a request is
 * pending, so those controls clear it *before* they send.
 */
export function goalClearsBlockingAfterSend(action: GoalAction): boolean {
  return action === 'pause' || action === 'remove';
}

/**
 * Mirrors the CLI goal actions: Pause is offered only while active. Resume is
 * offered for every non-active state — the CLI continues a paused goal, resumes
 * a blocked goal once its blocker is resolved, and restarts a complete goal.
 * Edit and Remove are always available.
 */
export function resolveGoalActions(goal: SessionGoal): GoalAction[] {
  const actions: GoalAction[] = ['edit'];
  if (goal.status === 'active') {
    actions.push('pause');
  } else {
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
