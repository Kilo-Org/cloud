import { AppRegistry } from 'react-native';

/**
 * The headless approve task. One literal, shared by the Android
 * `ActiveAgentsApproveTaskService` that starts the task and this registration
 * that names it; a mismatch would leave the notification action with no task.
 */
export const APPROVE_AGENT_TASK_KEY = 'ActiveAgentsApprove';

/** The approval the task runs. Injected so the flow is unit-testable. */
export type ApproveRunner = () => Promise<void>;

/**
 * Run one approval headless, from the ongoing notification's Approve action.
 *
 * The stored language goes first, for the same reason a widget redraw applies
 * it: the process has no Activity, so nothing else has switched i18n and the
 * surface the approval republishes would render English. Then the same service
 * the phone's permission card backs runs, and it republishes the surfaces
 * before it resolves.
 *
 * A rejection never reaches Android — `AppRegistry.startHeadlessTask` only
 * finishes the native task for a resolved promise, so a rejection would hold
 * the service's wake lock until its timeout. Every failure is swallowed here,
 * and the surface republish inside the service is what shows the user whether
 * the approval landed.
 */
export async function runApproveTask(
  approve: ApproveRunner = loadApproveFrontAgent
): Promise<void> {
  await applyLanguageBestEffort();
  try {
    await approve();
  } catch {
    // Swallowed by design; see the doc comment above.
  }
}

/**
 * The language is copy only: a failure there must not swallow the tap the user
 * made, so it is best-effort and the approval runs in whatever language the
 * process already has.
 */
async function applyLanguageBestEffort(): Promise<void> {
  try {
    // The import does double duty: it registers the Android sink the refreshed
    // surfaces have to reach, and it hands over the one language step a
    // headless process has nothing else to run.
    //
    // Loaded on task fire, not at app entry: the entry registers the task name
    // only, so requiring this module never starts i18n or SecureStore before
    // `expo-router/entry` sets the app up.
    const { applyWidgetLanguage } = await import('./register');
    await applyWidgetLanguage();
  } catch {
    // Swallowed by design; see the doc comment above.
  }
}

/** The wired default: the one s2 approval service both wrists share. */
async function loadApproveFrontAgent(): Promise<void> {
  const { approveFrontAgent } = await import('@/lib/glanceable/approve-front-agent');
  await approveFrontAgent();
}

/** The registered task. Android passes an empty data map, which is ignored. */
async function approveTask(): Promise<void> {
  await runApproveTask();
}

/**
 * Register the headless task for the notification action. Called from the app
 * entry, before `expo-router/entry`: Android can deliver the action to a cold
 * process that never had a widget redraw.
 */
export function registerApproveTask(): void {
  AppRegistry.registerHeadlessTask(APPROVE_AGENT_TASK_KEY, () => approveTask);
}
