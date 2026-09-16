// The app entry.
//
// Android redraws a placed widget, and answers the ongoing notification's
// Approve action, from a headless JS task: the bundle loads with no Activity,
// no route and no notification handler runs first, so both tasks have to be
// registered here. Each slice loads only when its task fires — requiring it at
// entry would start i18n and SecureStore before `expo-router/entry` sets the
// app up.
//
// `require`, not `import`: ESM hoisting would run `expo-router/entry` first.
const { Platform } = require('react-native');

if (Platform.OS === 'android') {
  const { registerWidgetTaskHandler } = require('react-native-android-widget');
  const { registerApproveTask } = require('./src/glanceable-android/approve-task');

  registerWidgetTaskHandler(async task => {
    const { handleWidgetTask } = require('./src/glanceable-android/register');
    await handleWidgetTask(task);
  });

  // The notification action can reach a cold process that never had a redraw.
  registerApproveTask();
}

require('expo-router/entry');
