// Local Expo module for Android Live Updates.
//
// Slice `and` (level 3) adds the Android native implementation under
// modules/active-agents-live-update/android and the Android sink under
// src/glanceable-android. Until then every function is a no-op so the module
// loads in the main process on both platforms.

export function start(_snapshot: unknown): void {
  // No-op until the Android native module lands.
}

export function update(_snapshot: unknown): void {
  // No-op until the Android native module lands.
}

export function end(_immediate?: boolean): void {
  // No-op until the Android native module lands.
}

export function isLiveUpdateCapable(): boolean {
  return false;
}

// The Android sink registers itself from the main process once slice `and`
// provides @/glanceable-android/register. The try/catch keeps this import a
// no-op before that file exists.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/glanceable-android/register');
} catch {
  // glanceable-android/register does not exist until slice `and` lands.
}
