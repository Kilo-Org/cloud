// The app entry.
//
// Android redraws a placed widget from a headless JS task, which loads this
// bundle with no Activity: no route and no notification handler runs first, so
// the widget task has to be registered here. The widget slice itself loads only
// when a task fires — requiring it at entry would start i18n and SecureStore
// before `expo-router/entry` sets the app up.
//
// `require`, not `import`: ESM hoisting would run `expo-router/entry` first.
const { Platform } = require('react-native');

if (Platform.OS === 'android') {
  const { registerWidgetTaskHandler } = require('react-native-android-widget');

  registerWidgetTaskHandler(async task => {
    const { handleWidgetTask } = require('./src/glanceable-android/register');
    await handleWidgetTask(task);
  });
}

require('expo-router/entry');

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
