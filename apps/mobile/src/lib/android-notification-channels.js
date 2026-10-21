/** The Android notification channels the app creates silent: no sound and no
 *  vibration. The channel writer (src/lib/notifications.ts) reads this list,
 *  and scripts/assert-expo-config.mjs reads the same list to keep the FCM
 *  fallback channel off it. Plain .js because that script runs under plain
 *  Node, which cannot load workspace TS (same reason env-keys.js exists).
 *  Android never changes a channel's sound after creation, so a channel that
 *  moves in or out of this list needs a new channel id instead.
 *  @type {ReadonlyArray<import('@kilocode/notifications').AndroidNotificationChannelId>} */
export const SILENT_ANDROID_NOTIFICATION_CHANNEL_IDS = Object.freeze([
  'agent-progress',
  'followed-sessions-lock-screen',
]);
