import type {
  ControlPlaneTransferGrantFrame,
  ControlPlaneTransferGrantResultFrame,
} from '../../shared/control-plane-protocol.js';
import { sandboxTransferScopes } from '../../shared/control-diagnostics.js';
import { mintSandboxTransferGrant } from '../../sandbox-control/sandbox-transfer-grant.js';
import type { AllocationState } from './allocation.js';

/**
 * Serves one `transfer.grant` request from the bound wrapper. The identity and
 * scopes come from durable allocation state, never from the frame, so a wrapper
 * can renew only the grant it already holds.
 */
export function serveTransferGrant(input: {
  frame: ControlPlaneTransferGrantFrame;
  sandboxId: string;
  state: AllocationState;
  signingSecret: string | null;
  send(frame: ControlPlaneTransferGrantResultFrame): void;
}): void {
  const fail = (code: string, message: string, retryable: boolean): void =>
    input.send({
      type: 'transfer.grant.result',
      requestId: input.frame.requestId,
      ok: false,
      error: { code, message, retryable },
    });
  const { state } = input;
  if (state.kind !== 'connected' || state.allocationId === null || state.wrapperId === null) {
    return fail('not_ready', 'Sandbox wrapper is not connected', true);
  }
  if (!input.signingSecret) {
    return fail('unavailable', 'Sandbox transfer grant signing is unavailable', true);
  }
  try {
    const minted = mintSandboxTransferGrant(
      {
        sandboxId: input.sandboxId,
        allocationId: state.allocationId,
        wrapperInstanceId: state.wrapperId,
      },
      sandboxTransferScopes,
      input.signingSecret
    );
    input.send({
      type: 'transfer.grant.result',
      requestId: input.frame.requestId,
      ok: true,
      grant: minted.grant,
      expiresAt: minted.expiresAt,
    });
  } catch {
    fail('unavailable', 'Sandbox transfer grant signing is unavailable', true);
  }
}
