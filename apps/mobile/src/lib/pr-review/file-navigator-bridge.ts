// Module-level bridge for the file-navigator's "scroll to file" request.
// The file navigator subscribes via `subscribeFileNavigatorRequest` and
// navigates the diff list when the user picks a file from the navigator
// sheet. `requestScrollToFile` is the producer side, called by the
// navigator sheet on selection. S6c implements both ends.
//
// Every request carries its owning PR identity, and subscribers register
// for a specific PR, so a navigation request emitted for one PR is never
// delivered to another PR's diff list if both remain mounted.

import { type PrIdentity } from './diff-selection-bridge';

export type FileNavigatorRequest = PrIdentity & {
  path: string;
};

type Listener = (request: FileNavigatorRequest) => void;

const listeners = new Set<{ pr: PrIdentity; listener: Listener }>();

function samePr(a: PrIdentity, b: PrIdentity): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase() &&
    a.number === b.number
  );
}

export function requestScrollToFile(request: FileNavigatorRequest) {
  for (const entry of listeners) {
    if (samePr(entry.pr, request)) {
      entry.listener(request);
    }
  }
}

export function subscribeFileNavigatorRequest(pr: PrIdentity, listener: Listener): () => void {
  const entry = { pr, listener };
  listeners.add(entry);
  return () => {
    listeners.delete(entry);
  };
}
