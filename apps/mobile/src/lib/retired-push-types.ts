/**
 * Push kinds this app has no product for. The shared schema still declares them
 * and the shared catalog still carries their copy until the senders stop, so
 * the foreground handler suppresses their banner and the history list drops the
 * rows a build already recorded: nothing this app would draw for one of them can
 * be opened.
 *
 * Kept out of `notification-history` so the notification handler does not pull
 * the push catalogs in just to read this set.
 */
const RETIRED_PUSH_TYPES = {
  'chat.message': true,
  'instance-lifecycle': true,
  'scheduled-action': true,
} satisfies Record<string, true>;

/** Whether a push or a recorded row belongs to a kind this app has retired. */
export function isRetiredPushType(pushType: string): boolean {
  return Object.hasOwn(RETIRED_PUSH_TYPES, pushType);
}
