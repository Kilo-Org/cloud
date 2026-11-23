import type { ControlPlaneFailureReason } from '../shared/control-plane-protocol.js';
import { ProviderCreationError, ProviderStoppedError } from './provider.js';

/** This module owns permanent provider failure reasons. */
export class ProviderLifecycleError extends Error {
  constructor(readonly reason: ControlPlaneFailureReason) {
    super(reason);
    this.name = 'ProviderLifecycleError';
  }
}

export function providerFailureReason(error: unknown): ControlPlaneFailureReason | undefined {
  if (error instanceof ProviderLifecycleError) return error.reason;
  if (error instanceof ProviderCreationError) return error.permanentReason ?? undefined;
  if (error instanceof ProviderStoppedError) return 'sandbox_lost';
  return undefined;
}
