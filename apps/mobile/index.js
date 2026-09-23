// The app entry.
//
// Android redraws a placed widget, and answers the ongoing notification's
// Approve action, from a headless JS task: the bundle loads with no Activity,
// no route and no notification handler runs first, so both tasks have to be
// registered here. The widget module loads only when its task fires — requiring
// it at entry would start the widget sink before `expo-router/entry` sets the
// app up.
//
// The Approve action on the Live Update notification boots the same kind of
// headless run, so its task is registered here too, under the key its Kotlin
// worker starts (`KiloActiveAgentsApprove`). `registerApproveTask` is the second
// registration that action can take, through `ActiveAgentsApproveTaskService`:
// it requires the task module itself, which is why the literal above is only a
// factory.
//
// `require`, not `import`: ESM hoisting would run `expo-router/entry` first.
const { AppRegistry, LogBox, Platform } = require('react-native');

// Drop expo-iap's developer copy for a failed available-purchases query before
// the first store query can log it. The Kilo Pass screen renders its own
// translated message for the same failure, so the library's English string must
// not paint a LogBox banner over it.
require('./src/lib/dev-logbox').applyDevLogBoxFilters(LogBox);

if (Platform.OS === 'android') {
  const { registerWidgetTaskHandler } = require('react-native-android-widget');
  const { registerApproveTask } = require('./src/glanceable-android/approve-task');

  registerWidgetTaskHandler(async task => {
    const { handleWidgetTask } = require('./src/glanceable-android/register');
    await handleWidgetTask(task);
  });

  // `KiloActiveAgentsApprove` is `APPROVE_HEADLESS_TASK_KEY`
  // (src/glanceable-android/approve-task.ts) and the Kotlin worker's
  // `TASK_NAME`; only the string crosses the native boundary, so the three are
  // asserted equal in approve-task.test.ts. The factory keeps this registration
  // bodyless, like the widget handler above; the module itself arrives with the
  // eager `registerApproveTask` require.
  AppRegistry.registerHeadlessTask(
    'KiloActiveAgentsApprove',
    () => require('./src/glanceable-android/approve-task').handleApproveTask
  );

  // The notification action can reach a cold process that never had a redraw.
  registerApproveTask();
}

require('expo-router/entry');

// Register the OS-action dispatcher after the router entry, for the reason the
// widget block above states — `require`, not `import`, so this module is
// evaluated after `expo-router/entry` sets the app up. The native side can hold
// a payload that arrived before any screen mounted (StartAgent with the app
// closed) and replays it into the registered handler.
const { registerAppActionDispatcher } = require('./src/lib/app-actions/app-action-dispatch');

void registerAppActionDispatcher();

// Approve / Reply on a needs-input notification and data-only glanceable pushes
// run through a background expo-notifications task, which Android starts from a
// headless JS context: it loads this bundle with no Activity and never evaluates
// the root layout, so the task has to be defined and registered here too, after
// the router entry. The registration is light — the task executor lazy-loads
// the notification module when a task fires (notification-background-task.ts).
require('./src/lib/notification-background-task')
  .registerNotificationBackgroundTask()
  .catch(() => {
    // Registration already reports its own failure; the entry must never crash.
  });
