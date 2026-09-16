// The app entry.
//
// Android redraws a placed widget from a headless JS task, which loads this
// bundle with no Activity: no route and no notification handler runs first, so
// the widget task has to be registered here. The widget slice itself loads only
// when a task fires — requiring it at entry would start i18n and SecureStore
// before `expo-router/entry` sets the app up.
//
// The Approve action on the Live Update notification boots the same kind of
// headless run, so its task is registered here too, and its module likewise
// loads only when the task fires.
//
// `require`, not `import`: ESM hoisting would run `expo-router/entry` first.
const { AppRegistry, Platform } = require('react-native');

if (Platform.OS === 'android') {
  const { registerWidgetTaskHandler } = require('react-native-android-widget');

  registerWidgetTaskHandler(async task => {
    const { handleWidgetTask } = require('./src/glanceable-android/register');
    await handleWidgetTask(task);
  });

  // `KiloActiveAgentsApprove` is `APPROVE_HEADLESS_TASK_KEY`
  // (src/glanceable-android/approve-task.ts) and the Kotlin worker's
  // `TASK_NAME`; only the string crosses the native boundary, so the three are
  // asserted equal in approve-task.test.ts. The literal keeps the task module
  // out of the entry graph: requiring it here would start i18n before
  // `expo-router/entry`.
  AppRegistry.registerHeadlessTask(
    'KiloActiveAgentsApprove',
    () => require('./src/glanceable-android/approve-task').handleApproveTask
  );
}

require('expo-router/entry');
