export type PendingAction = {
  messageId: string;
  groupId: string;
};

export type PendingActionStore = {
  current: PendingAction | null;
};

function pendingActionMatches(a: PendingAction | null, b: PendingAction): boolean {
  return a?.messageId === b.messageId && a.groupId === b.groupId;
}

export function pendingActionGroupIdForMessage(
  pendingAction: PendingAction | null,
  messageId: string
): string | null {
  return pendingAction?.messageId === messageId ? pendingAction.groupId : null;
}

export function tryStartPendingAction(
  store: PendingActionStore,
  pendingAction: PendingAction
): boolean {
  if (store.current !== null) {
    return false;
  }
  store.current = pendingAction;
  return true;
}

export function clearPendingAction(store: PendingActionStore, pendingAction: PendingAction): void {
  if (pendingActionMatches(store.current, pendingAction)) {
    store.current = null;
  }
}
