// The app entry.
//
// Android redraws a placed widget from a headless JS task, which loads this
// bundle with no Activity and therefore never evaluates an expo-router route.
// `registerWidgetTaskHandler` has to have run by then, so the Android glanceable
// slice is required here rather than from the root layout, and before
// `expo-router/entry` so the registration cannot depend on routing at all.
//
// `require`, not `import`: ESM hoisting would run `expo-router/entry` first.
const { Platform } = require('react-native');

if (Platform.OS === 'android') {
  require('./src/glanceable-android/register');
}

require('expo-router/entry');
