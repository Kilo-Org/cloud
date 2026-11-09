/**
 * Navigation actions that mean "the user is leaving this screen": the header
 * back button and Android hardware back (`GO_BACK`), the iOS swipe-back
 * gesture and programmatic `router.back()` (`POP`). Every other action that
 * can remove a screen — a `NAVIGATE`/`PUSH` to another route, a `RESET` — is
 * forward navigation, not an abandoned screen.
 *
 * Shared by the new-session discard confirm and the picker Back rule so both
 * treat the same removal the same way.
 */
const LEAVE_ACTIONS = {
  GO_BACK: true,
  POP: true,
  POP_TO: true,
  POP_TO_TOP: true,
} satisfies Record<string, true>;

export function isLeaveAction(actionType: string): boolean {
  return Object.hasOwn(LEAVE_ACTIONS, actionType);
}
