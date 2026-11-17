/**
 * Push kinds this app has no product for. The shared schema no longer declares
 * them and the shared catalog no longer carries their copy, but a server that
 * has not stopped sending them still delivers them: a foreground banner would
 * be drawn from the server-supplied title and body, and its tap would resolve
 * no route. The foreground handler therefore suppresses their banner and the
 * history list drops the rows a build already recorded.
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
