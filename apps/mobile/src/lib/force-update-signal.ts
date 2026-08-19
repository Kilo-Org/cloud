type Listener = () => void;

const listeners = new Set<Listener>();
let forceUpdateRequired = false;

function readUpstreamCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const direct = (error as { data?: unknown }).data;
  if (typeof direct === 'object' && direct !== null) {
    return (direct as { upstreamCode?: unknown }).upstreamCode;
  }
  const shaped = (error as { shape?: { data?: unknown } }).shape?.data;
  if (typeof shaped === 'object' && shaped !== null) {
    return (shaped as { upstreamCode?: unknown }).upstreamCode;
  }
  return undefined;
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Flips the module-level flag to true (and notifies) when the error carries
 * `upstreamCode === 'app_update_required'`. Any other error is a no-op.
 */
export function reportTrpcError(error: unknown): void {
  if (readUpstreamCode(error) !== 'app_update_required' || forceUpdateRequired) {
    return;
  }
  forceUpdateRequired = true;
  notify();
}

export function subscribeToForceUpdateSignal(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getForceUpdateSignalSnapshot(): boolean {
  return forceUpdateRequired;
}

/**
 * Resets the flag to false and notifies. Load-bearing: without it, lowering the
 * minimum can never clear the block.
 */
export function clearForceUpdateSignal(): void {
  if (!forceUpdateRequired) {
    return;
  }
  forceUpdateRequired = false;
  notify();
}
