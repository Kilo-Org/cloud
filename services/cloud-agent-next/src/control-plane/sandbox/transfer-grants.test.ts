import { describe, expect, it, vi } from 'vitest';
import type {
  ControlPlaneTransferGrantFrame,
  ControlPlaneTransferGrantResultFrame,
} from '../../shared/control-plane-protocol.js';
import { validateSandboxTransferGrant } from '../../sandbox-control/sandbox-transfer-grant.js';
import { initialAllocationState, type AllocationState } from './allocation.js';
import { serveTransferGrant } from './transfer-grants.js';

const secret = 'renewal-test-secret';
const sandboxId = 'sandbox_test';
const allocationId = 'allocation_test';
const wrapperId = '0fce125c-54a3-4143-b503-b7775c4d2135';

function connectedState(overrides: Partial<AllocationState> = {}): AllocationState {
  return {
    ...initialAllocationState(),
    kind: 'connected',
    allocationId,
    connectionId: 'connection-1',
    wrapperId,
    ...overrides,
  };
}

function serve(state: AllocationState, signingSecret: string | null = secret) {
  const sent: ControlPlaneTransferGrantResultFrame[] = [];
  const frame: ControlPlaneTransferGrantFrame = {
    type: 'transfer.grant',
    requestId: 'request-1',
  };
  serveTransferGrant({
    frame,
    sandboxId,
    state,
    signingSecret,
    send: result => sent.push(result),
  });
  return sent;
}

describe('serveTransferGrant', () => {
  it('mints for the allocation identity with both scopes', () => {
    const [result] = serve(connectedState());
    expect(result).toMatchObject({
      type: 'transfer.grant.result',
      requestId: 'request-1',
      ok: true,
    });
    if (!result || !result.ok) throw new Error('expected a grant result');
    const grant = validateSandboxTransferGrant(`Bearer ${result.grant}`, secret);
    expect(grant).toMatchObject({
      identity: { sandboxId, allocationId, wrapperInstanceId: wrapperId },
      scopes: ['logs', 'workspace_artifacts'],
    });
    expect(result.expiresAt).toBe(grant?.expiresAt);
  });

  it('refuses a stale or disconnected allocation', () => {
    for (const state of [
      connectedState({ kind: 'disconnected' }),
      connectedState({ allocationId: null }),
      connectedState({ wrapperId: null }),
    ]) {
      expect(serve(state)).toEqual([
        {
          type: 'transfer.grant.result',
          requestId: 'request-1',
          ok: false,
          error: {
            code: 'not_ready',
            message: 'Sandbox wrapper is not connected',
            retryable: true,
          },
        },
      ]);
    }
  });

  it('reports unavailable when signing is unavailable', () => {
    const send = vi.fn();
    serveTransferGrant({
      frame: { type: 'transfer.grant', requestId: 'request-1' },
      sandboxId,
      state: connectedState(),
      signingSecret: null,
      send,
    });
    expect(send).toHaveBeenCalledWith({
      type: 'transfer.grant.result',
      requestId: 'request-1',
      ok: false,
      error: {
        code: 'unavailable',
        message: 'Sandbox transfer grant signing is unavailable',
        retryable: true,
      },
    });
  });
});
