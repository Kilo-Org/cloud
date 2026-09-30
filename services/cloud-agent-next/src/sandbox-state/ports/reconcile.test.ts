import { afterEach, describe, expect, it, vi, expectTypeOf } from 'vitest';
import type { SandboxRecovery } from '../../shared/sandbox-control-protocol.js';
import type { SandboxControlSocketHandler } from '../../sandbox-control/socket.js';
import { ReconcilePortError, createReconcilePort, type ReconcileSendRequest } from './reconcile.js';

const recovery: SandboxRecovery = {
  episodeId: '11111111-1111-4111-8111-111111111111',
  cause: 'heartbeat_expired',
  startedAt: 1_000,
  deadlineAt: 2_000,
  attempt: 3,
};

const attempt = {
  expectedWrapperInstanceId: 'wrapper_1',
  episodeId: recovery.episodeId,
  attempt: recovery.attempt,
  deadlineAt: 2_000,
};

function recorder(): {
  sendRequest: ReconcileSendRequest;
  calls: Parameters<ReconcileSendRequest>[0][];
} {
  const calls: Parameters<ReconcileSendRequest>[0][] = [];
  const sendRequest: ReconcileSendRequest = async input => {
    calls.push(input);
    if (input.operation === 'sandbox.reconcile') {
      return {
        ok: true,
        result: {
          episodeId: recovery.episodeId,
          attempt: recovery.attempt,
          phase: (input.payload as { phase: string }).phase,
        },
      };
    }
    return { ok: true, result: { healthy: true, state: 'idle', version: '1', kiloReady: true } };
  };
  return { sendRequest, calls };
}

afterEach(() => vi.useRealTimers());

describe('reconcile port', () => {
  it('is assignable from the production control transport', () => {
    expectTypeOf<
      SandboxControlSocketHandler['sendRequest']
    >().toMatchTypeOf<ReconcileSendRequest>();
  });

  it('sends the reconcile phase with the explicit attempt identity and remaining timeout', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_500);
    const { sendRequest, calls } = recorder();
    const port = createReconcilePort(sendRequest);

    await port.sendPhase({ ...attempt, recovery, phase: 'drain' });

    expect(calls).toEqual([
      {
        operation: 'sandbox.reconcile',
        expectedWrapperInstanceId: 'wrapper_1',
        payload: { recovery, phase: 'drain' },
        deadlineAt: 2_000,
        timeoutMs: 500,
      },
    ]);
  });

  it.each([
    {
      name: 'episode',
      result: {
        episodeId: '22222222-2222-4222-8222-222222222222',
        attempt: recovery.attempt,
        phase: 'commit',
      },
    },
    {
      name: 'attempt',
      result: { episodeId: recovery.episodeId, attempt: recovery.attempt - 1, phase: 'commit' },
    },
    {
      name: 'phase',
      result: { episodeId: recovery.episodeId, attempt: recovery.attempt, phase: 'drain' },
    },
  ])('rejects an acknowledgement with a changed $name', async ({ result }) => {
    const port = createReconcilePort(async () => ({ ok: true, result }));

    await expect(port.sendPhase({ ...attempt, recovery, phase: 'commit' })).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('reports a non-acknowledged reconcile as retryable', async () => {
    const port = createReconcilePort(async () => ({ ok: false }));

    const rejection = port.sendPhase({ ...attempt, recovery, phase: 'ready' });
    await expect(rejection).rejects.toBeInstanceOf(ReconcilePortError);
    await expect(rejection).rejects.toMatchObject({ retryable: true });
  });

  it('probes readiness through sandbox.status and reports the kiloReady bit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_500);
    const { sendRequest, calls } = recorder();
    const port = createReconcilePort(sendRequest);

    await expect(port.probeReady(attempt)).resolves.toBe(true);
    expect(calls).toEqual([
      {
        operation: 'sandbox.status',
        expectedWrapperInstanceId: 'wrapper_1',
        payload: {},
        deadlineAt: 2_000,
        timeoutMs: 500,
      },
    ]);
  });

  it('reports not ready when the status request fails or omits kiloReady', async () => {
    const failing = createReconcilePort(async () => ({ ok: false }));
    await expect(failing.probeReady(attempt)).resolves.toBe(false);

    const unready = createReconcilePort(async () => ({
      ok: true,
      result: { healthy: true, state: 'idle', version: '1' },
    }));
    await expect(unready.probeReady(attempt)).resolves.toBe(false);
  });
});
