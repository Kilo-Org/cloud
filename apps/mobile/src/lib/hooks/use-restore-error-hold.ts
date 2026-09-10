import { useLayoutEffect, useState } from 'react';

type RestoreErrorHoldInput = {
  /** The settled restore error: every retried startup credential read failed. */
  readonly hasRestoreError: boolean;
  /** The bootstrap gate hides the tree while the retried bootstrap finishes. */
  readonly hidden: boolean;
  /** A sign-out started: the escape hatch owns the tree from here. */
  readonly isSigningOut: boolean;
};

/**
 * Holds the settled restore-error surface while the retried bootstrap
 * finishes, and reports when the surface may leave the screen.
 *
 * A successful Retry does not reveal the app immediately: the token publish,
 * the user fetch, and the consent check still run behind the bootstrap gate,
 * and the splash overlay that covers a cold start's hidden window is already
 * gone (startup completed when the error settled). Dropping the error screen
 * the moment `restoreFailed` clears would expose that hidden window as a
 * blank frame before Home. The hold keeps the settled surface mounted until
 * the gate actually reveals the tree, so the error screen and the revealed
 * tree swap with no blank frame between them.
 *
 * Returns true while the surface must stay up. The release runs in a layout
 * effect, so the swap happens inside one paint.
 */
export function useRestoreErrorHold(input: RestoreErrorHoldInput): boolean {
  const [holding, setHolding] = useState(false);
  useLayoutEffect(() => {
    if (input.isSigningOut) {
      setHolding(false);
      return;
    }
    if (input.hasRestoreError) {
      setHolding(true);
      return;
    }
    if (!input.hidden) {
      setHolding(false);
    }
  }, [input.hasRestoreError, input.hidden, input.isSigningOut]);
  return input.hasRestoreError || holding;
}
