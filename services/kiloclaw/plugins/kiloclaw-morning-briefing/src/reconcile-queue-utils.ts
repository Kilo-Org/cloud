export type ReconcileAction = 'enable' | 'disable';

export function resolveNextReconcileAction(params: {
  queuedAction: ReconcileAction | null;
  desiredEnabled: boolean;
  observedEnabled: boolean | null;
}): ReconcileAction | null {
  if (params.queuedAction) {
    return params.queuedAction;
  }

  if (params.observedEnabled === null) {
    return null;
  }

  if (params.observedEnabled !== params.desiredEnabled) {
    return params.desiredEnabled ? 'enable' : 'disable';
  }

  return null;
}
