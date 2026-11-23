import { withTimeout } from '@kilocode/worker-utils';
import { providerFailureReason } from '../../sandbox-control/provider-failure.js';
import type {
  ControlPlaneFailureReason,
  ControlPlaneWrapperFrame,
} from '../../shared/control-plane-protocol.js';
import type {
  ProviderAdapter,
  ProviderLaunchResult,
  ProviderDeadline,
} from '../../sandbox-control/provider.js';
import type { AllocationState } from './allocation.js';

/** Deadlines come from durable provider state. A healthy wrapper does not need provider polling. */
export async function providerDeadline(
  provider: ProviderAdapter,
  state: AllocationState
): Promise<ProviderDeadline | undefined> {
  if (state.kind === 'stopped' || state.kind === 'stopping' || state.providerRef === null)
    return undefined;
  return provider.allocationDeadline?.(state.providerRef);
}

/** A hello keeps the authority observed before external provider validation. */
export type ProviderHelloAdmission = {
  frame: Extract<ControlPlaneWrapperFrame, { type: 'hello' }>;
  provider: ProviderAdapter;
  providerRef: string | null;
  connectionId: string | null;
  credential: string | null;
  deadlineAt: number | undefined;
};
export type ProviderHelloDecision =
  | { kind: 'bind' }
  | { kind: 'retry' }
  | { kind: 'stop'; reason: ControlPlaneFailureReason };

/** This module owns provider lifecycle decisions; the DO applies allocation transitions. */
export async function validateProviderHello(
  admission: ProviderHelloAdmission,
  timeoutMs: number
): Promise<ProviderHelloDecision> {
  if (admission.providerRef === null || !admission.provider.validateWrapperAdmission)
    return { kind: 'bind' };
  try {
    await withTimeout(
      admission.provider.validateWrapperAdmission(admission.providerRef),
      Math.max(1, Math.min(timeoutMs, (admission.deadlineAt ?? Infinity) - Date.now())),
      'Provider wrapper admission timed out'
    );
    return { kind: 'bind' };
  } catch (error) {
    const reason = providerFailureReason(error);
    return reason ? { kind: 'stop', reason } : { kind: 'retry' };
  }
}

export type ProviderReconciliation =
  | { kind: 'launched'; result: ProviderLaunchResult }
  | { kind: 'absent' }
  | { kind: 'retry' }
  | { kind: 'stop'; reason: ControlPlaneFailureReason };

export async function reconcileProviderLaunch(
  reconcile: () => Promise<ProviderLaunchResult | undefined>,
  timeoutMs: number
): Promise<ProviderReconciliation> {
  try {
    const result = await withTimeout(
      reconcile(),
      timeoutMs,
      'Provider launch reconciliation timed out'
    );
    return result ? { kind: 'launched', result } : { kind: 'absent' };
  } catch (error) {
    const reason = providerFailureReason(error);
    return reason ? { kind: 'stop', reason } : { kind: 'retry' };
  }
}
