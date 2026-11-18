// Local Expo module for Android Live Updates.
//
// Android-only by capability: Android's Live Update is the promoted ongoing
// notification the Kotlin module owns, and iOS has no such surface — it renders
// the same feature as an ActivityKit Live Activity through `expo-widgets`
// (`src/glanceable-ios/`). Both drive the one shared pipeline under
// `src/lib/glanceable/`.
//
// There is no JS API to expose here. The Android sink reaches the native module
// directly through `requireOptionalNativeModule('ActiveAgentsLiveUpdate')`
// (`src/glanceable-android/live-update.ts`), so the functions below stay unused
// placeholders; this file is imported for its side effect, registering the
// Android sink on the one platform that can load it.

export function start(_snapshot: unknown): void {
  // Unused: the Android sink calls the native module (glanceable-android/live-update.ts).
}

export function update(_snapshot: unknown): void {
  // Unused: the Android sink calls the native module (glanceable-android/live-update.ts).
}

export function end(_immediate?: boolean): void {
  // Unused: the Android sink calls the native module (glanceable-android/live-update.ts).
}

export function isLiveUpdateCapable(): boolean {
  return false;
}

// The Android sink registers itself from the main process through the Android
// sink's own module, which imports `react-native-android-widget` — an
// Android-only native package with no iOS implementation. The try/catch is that
// capability gate, not a build-order placeholder: on iOS the require throws and
// the iOS sink registered by `@/glanceable-ios/register` stands alone.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/glanceable-android/register');
} catch {
  // No Android notification surface on this platform.
}
