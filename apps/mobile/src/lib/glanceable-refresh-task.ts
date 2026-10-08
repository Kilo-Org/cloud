/**
 * Headless-visible registration for the periodic glanceable refresh.
 *
 * The data-only `active_agents_glanceable` push keeps the widgets, the ongoing
 * notification and the Live Activity current. The OS can drop or throttle that
 * push, so this task reads the tray on the OS schedule as a fallback. Android
 * runs it through WorkManager in a headless JS context that evaluates only the
 * app entry, and iOS runs it through BGTaskScheduler, so the task is defined
 * here, from the entry, like the notification task.
 *
 * The OS owns the schedule: `minimumInterval` is a floor, not a period, and
 * iOS can skip runs entirely. The executor lazy-loads `./notifications` when a
 * run fires, so a start that never runs the task pays nothing for it.
 */

import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import { reportRegistrationFailure } from './notification-background-task';

export const GLANCEABLE_REFRESH_TASK = 'active-agents-glanceable-refresh';

/** WorkManager's floor for a periodic job; a shorter request runs at 15 min. */
const MINIMUM_INTERVAL_MINUTES = 15;

type NotificationsModule = {
  runGlanceableBackgroundRefresh: () => Promise<BackgroundTask.BackgroundTaskResult>;
};

/**
 * Define and register the periodic refresh. Called from the app entry.
 * `defineTask` overwrites the same name and the native registration is
 * idempotent, so every start can call it.
 */
export async function registerGlanceableRefreshTask(): Promise<void> {
  TaskManager.defineTask(GLANCEABLE_REFRESH_TASK, async () => {
    // Lazy: the entry requires this file on every start, and `./notifications`
    // carries the RN / i18n / SecureStore graph only a run needs.
    const { runGlanceableBackgroundRefresh } =
      (await import('./notifications')) as NotificationsModule;
    return runGlanceableBackgroundRefresh();
  });
  try {
    await BackgroundTask.registerTaskAsync(GLANCEABLE_REFRESH_TASK, {
      minimumInterval: MINIMUM_INTERVAL_MINUTES,
    });
  } catch (error) {
    void reportRegistrationFailure(error, 'register_glanceable_refresh_task');
  }
}
