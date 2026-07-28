/** Alert when the user picks a remote "Run on" target while a share is staged. */
export const SHARE_TO_NEW_REMOTE_SESSION_ALERT = {
  title: "Can't share to a new remote session",
  message:
    "A session started on a remote CLI can't receive shared text or files from this screen. Start a cloud session, or open the share sheet and pick a connected CLI to start a new session there.",
} as const;

/**
 * Toast when a remote spawn finishes ready but navigation is cancelled
 * because a share was staged mid-flight. The spawned session still exists.
 */
export const SHARE_STAGED_SPAWN_NAVIGATION_CANCELLED_TOAST =
  "Shared content can't start a remote session. The spawned session is in your session list.";

/** True when a non-empty shareId is staged on the new-session route. */
export function hasStagedShareId(shareId: string | undefined): boolean {
  return shareId != null && shareId !== '';
}

/**
 * Block selecting a remote "Run on" target while a share has been staged on
 * this screen mount (one-way latch). Clearing Cloud Agent (`next === null`)
 * is always allowed.
 */
export function shouldBlockRemoteRunOnSelection(
  shareStaged: boolean,
  next: unknown | null
): boolean {
  return shareStaged && next !== null;
}

/**
 * Cancel ready-spawn navigation when a share was staged during the in-flight
 * spawn so the prefilled draft is not stranded on the new-session screen.
 */
export function shouldCancelSpawnNavigationForStagedShare(shareStaged: boolean): boolean {
  return shareStaged;
}
