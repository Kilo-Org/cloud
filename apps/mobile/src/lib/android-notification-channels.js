// @ts-check
/** The Android notification channels the app creates silent: no sound and no
 *  vibration. The channel writer (src/lib/notifications.ts) reads this list,
 *  and scripts/assert-expo-config.mjs reads the same list to keep the FCM
 *  fallback channel off it. Plain .js because that script runs under plain
 *  Node, which cannot load workspace TS (same reason env-keys.js exists).
 *  Checked by the mobile typecheck through tsconfig include — keep the entry.
 *  Android never changes a channel's sound after creation, so a channel that
 *  moves in or out of this list needs a new channel id instead.
 *  @type {ReadonlyArray<import('@kilocode/notifications').AndroidNotificationChannelId>} */
export const SILENT_ANDROID_NOTIFICATION_CHANNEL_IDS = Object.freeze([
  'agent-progress',
  'followed-sessions-lock-screen',
]);

/** The Android notification channels this app creates: one entry per channel
 *  its writer (src/lib/notifications.ts) sets up at startup and on a headless
 *  start, so a push addressed to any of these reaches the system list. Plain
 *  .js for the same reason as the silent list above.
 *  @type {ReadonlyArray<import('@kilocode/notifications').AndroidNotificationChannelId>} */
export const CREATED_ANDROID_NOTIFICATION_CHANNEL_IDS = Object.freeze([
  'needs-input',
  'agent-progress',
  'agent-briefing',
  'balance',
  'security',
  'followed-sessions-lock-screen',
]);
