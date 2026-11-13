import { useLayoutEffect, useSyncExternalStore } from 'react';

/**
 * The in-tree modal surfaces the app has open right now, and the veil the root
 * applies while one is.
 *
 * A `DialogCard` is a `@rn-primitives/portal` card: it renders into the app-root
 * `PortalHost`, inside the app's own window, so the screen it covers stays in
 * the same accessibility tree. Android ignores the card's
 * `accessibilityViewIsModal`, so a screen reader walked the covered hub rows,
 * the back control and the tab bar before the dialog's own controls (measured
 * on the emulator with `uiautomator dump --compressed`: 40 named nodes behind an
 * open rename card, its content last). The preview overlay is the other in-tree
 * modal portal and had the same shape.
 *
 * The covered presentation itself belongs to the app root, which wraps the
 * navigator and the app chrome in one view and leaves the `PortalHost` outside
 * it. A surface therefore does not draw the veil; it only says it is open, and
 * the root hides everything the portal is not.
 *
 * Native sheets need no holder: Android gives each one its own dialog window,
 * which is why a presented `Sheet` already leaves only its own content in the
 * dump. A route `formSheet` is covered by `CoveredScreenA11yGate` in
 * `components/app-screen-layout.tsx`.
 *
 * Do not hold this for a `Sheet`: on the other platform the sheet's content
 * renders inside the app tree, where the veil would hide the sheet itself.
 */
let presented = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Holds the veil; the returned release ends this surface's hold. */
export function holdModalSurface(): () => void {
  presented += 1;
  emit();
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    presented -= 1;
    emit();
  };
}

/** Whether any in-tree modal surface is open. */
export function isModalSurfacePresented(): boolean {
  return presented > 0;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The root's read of the veil; re-renders only when it flips. */
export function useModalSurfacePresented(): boolean {
  return useSyncExternalStore(subscribe, isModalSurfacePresented, isModalSurfacePresented);
}

/**
 * Holds the veil for as long as the calling component is mounted. Mount a modal
 * surface only while it is open, the way `DialogCard` callers mount
 * `RenameModal`, so the hold ends with the surface.
 */
export function useModalSurfaceHold(): void {
  useLayoutEffect(() => holdModalSurface(), []);
}
