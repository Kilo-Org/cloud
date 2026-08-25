// Route-scoped bridge for the file-navigator's "scroll to file" request.
// The file navigator subscribes via `subscribeFileNavigatorRequest` and
// navigates the diff list when the user picks a file from the navigator
// sheet. `requestScrollToFile` is the producer side, called by the
// navigator sheet on selection.
//
// Every request carries its owning PR identity, and subscribers register for
// a specific PR's route key in the route registry, so a navigation request
// emitted for one PR is never delivered to another PR's diff list if both
// remain mounted.

import { type PrIdentity } from './diff-selection-bridge';
import { prFileNavSlot, prRouteKey } from '../route-registry';

export type FileNavigatorRequest = PrIdentity & {
  path: string;
};

type Listener = (request: FileNavigatorRequest) => void;

export function requestScrollToFile(request: FileNavigatorRequest) {
  const listeners = prFileNavSlot.get(prRouteKey(request));
  if (!listeners) {
    return;
  }
  for (const listener of listeners) {
    listener(request);
  }
}

export function subscribeFileNavigatorRequest(pr: PrIdentity, listener: Listener): () => void {
  const routeKey = prRouteKey(pr);
  const existing = prFileNavSlot.get(routeKey);
  if (existing) {
    existing.add(listener);
  } else {
    prFileNavSlot.set(routeKey, new Set([listener]));
  }
  return () => {
    const listeners = prFileNavSlot.get(routeKey);
    if (!listeners) {
      return;
    }
    listeners.delete(listener);
    if (listeners.size === 0) {
      prFileNavSlot.clear(routeKey);
    }
  };
}
