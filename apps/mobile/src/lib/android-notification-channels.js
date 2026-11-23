// @ts-check
/** One entry per Android notification channel this app creates, in creation
 *  order, recording whether the channel is silent: no sound and no vibration.
 *  Both exported lists below derive from this table, so the silent set is a
 *  subset of the created set by construction and each id is written once.
 *  Android never changes a channel's sound after creation, so a channel that
 *  moves in or out of silence needs a new channel id instead. Plain .js for
 *  the reason env-keys.js states. Checked by the mobile typecheck through
 *  tsconfig include — keep the entry.
 *  @type {ReadonlyArray<{ id: import('@kilocode/notifications').AndroidNotificationChannelId, silent: boolean }>} */
const ANDROID_NOTIFICATION_CHANNELS_CREATED = Object.freeze([
  { id: 'needs-input', silent: false },
  { id: 'agent-progress', silent: true },
  { id: 'agent-briefing', silent: false },
  { id: 'balance', silent: false },
  { id: 'security', silent: false },
  { id: 'followed-sessions-lock-screen', silent: true },
]);

/** The Android notification channels the app creates silent: no sound and no
 *  vibration. The channel writer (src/lib/notifications.ts) reads this list,
 *  and scripts/assert-expo-config.mjs reads the same list to keep the FCM
 *  fallback channel off it.
 *  @type {ReadonlyArray<import('@kilocode/notifications').AndroidNotificationChannelId>} */
export const SILENT_ANDROID_NOTIFICATION_CHANNEL_IDS = Object.freeze(
  ANDROID_NOTIFICATION_CHANNELS_CREATED.filter(channel => channel.silent).map(channel => channel.id)
);

/** The Android notification channels this app creates: one entry per channel
 *  its writer (src/lib/notifications.ts) sets up at startup and on a headless
 *  start, so a push addressed to any of these reaches the system list.
 *  @type {ReadonlyArray<import('@kilocode/notifications').AndroidNotificationChannelId>} */
export const CREATED_ANDROID_NOTIFICATION_CHANNEL_IDS = Object.freeze(
  ANDROID_NOTIFICATION_CHANNELS_CREATED.map(channel => channel.id)
);
