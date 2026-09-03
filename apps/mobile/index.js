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
