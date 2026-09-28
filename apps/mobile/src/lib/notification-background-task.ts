/**
 * Headless-visible registration for the background notification task.
 *
 * Android runs a notification response (an Approve / Reply tap with the app
 * closed) and a data-only glanceable push through a background
 * expo-notifications task, which it starts from a headless JS context that
 * evaluates only the app entry (`index.js`) — never the root layout. So the
 * task must be defined and registered here, from the entry, exactly like the
 * widget task handler is.
 *
 * This module stays light on purpose: the entry requires it on every start,
 * including widget redraws that never touch a notification. The task executor
 * lazy-loads `./notifications` (the heavy RN / i18n / SecureStore graph) when a
 * task actually fires.
 */

import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';

/**
 * The single background-notification task name. One name only: the native side
 * hands a notification response to every registered consumer, so a second name
 * would run an Approve / Reply twice.
 */
export const BACKGROUND_NOTIFICATION_TASK = 'active-agents-glanceable-background-task';

/** The shape of the runner the executor lazy-loads out of `./notifications`. */
type NotificationsModule = {
  runBackgroundNotificationTask: (
    body: TaskManager.TaskManagerTaskBody<Notifications.NotificationTaskPayload>
  ) => Promise<Notifications.BackgroundNotificationTaskResult>;
};

async function reportRegistrationFailure(error: unknown): Promise<void> {
  try {
    // Dynamic import keeps @sentry/react-native out of the entry graph: it
    // loads only when a registration actually fails.
    const Sentry = await import('@sentry/react-native');
    Sentry.captureException(error, {
      tags: {
        'error.subsystem': 'notifications',
        'error.operation': 'register_background_task',
      },
    });
  } catch {
    // Reporting is best effort; a failed registration must not crash the entry.
  }
}

/**
 * Define and register the background notification task where a headless JS
 * start can see it. Called from the app entry (after `expo-router/entry`);
 * `setupNotificationBackgroundHandler` defines the same task name directly for
 * the warm app. Both are safe: `defineTask` overwrites the same name and the
 * native registration is idempotent.
 */
export async function registerNotificationBackgroundTask(): Promise<void> {
  TaskManager.defineTask<Notifications.NotificationTaskPayload>(
    BACKGROUND_NOTIFICATION_TASK,
    async body => {
      const { runBackgroundNotificationTask } =
        (await import('./notifications')) as NotificationsModule;
      return runBackgroundNotificationTask(body);
    }
  );
  try {
    await Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK);
  } catch (error) {
    void reportRegistrationFailure(error);
  }
}
