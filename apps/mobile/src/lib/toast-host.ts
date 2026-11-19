import { useSyncExternalStore } from 'react';

/**
 * Which surface draws the app's toasts.
 *
 * On Android a native sheet covers the root Toaster in the app's main view
 * tree: the imperative `Sheet` is its own window, so a `toast.error` raised
 * while one was open stayed invisible until it closed. Every open sheet there
 * (route sheets too, so the in-sheet placement is one rule) mounts a
 * `SheetToastScope`, which claims a host here, and `AppToaster` renders into
 * the top claim; with no claim it renders in the main tree. iOS never claims:
 * the root Toaster's window-level overlay already draws above every presented
 * sheet.
 *
 * The top claim is the deepest one — a sheet presented from another sheet's
 * content sits above it even when both mount in one commit — and among sheets
 * at one depth the latest, since a sheet opened later presents over the
 * earlier one. A release hands the toasts back to the sheet below or the root.
 */
type Claim = Readonly<{ host: string; depth: number }>;

const claims: Claim[] = [];
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function topHost(): string | null {
  let top: Claim | null = null;
  for (const claim of claims) {
    if (!top || claim.depth >= top.depth) {
      top = claim;
    }
  }
  return top?.host ?? null;
}

/** Makes `host` a candidate to draw the toasts until the returned release runs. */
export function claimToastHost(host: string, depth: number): () => void {
  const claim = { host, depth };
  claims.push(claim);
  publish();
  return () => {
    const index = claims.indexOf(claim);
    if (index !== -1) {
      claims.splice(index, 1);
      publish();
    }
  };
}

/** The sheet host that draws the toasts, or `null` when the root Toaster does. */
export function useToastHost(): string | null {
  return useSyncExternalStore(subscribe, topHost, topHost);
}
