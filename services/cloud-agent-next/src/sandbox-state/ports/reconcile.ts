/**
 * Narrow wire port for the `sandbox.reconcile` recovery protocol. It carries only
 * the transport operations — a reconcile phase and the `sandbox.status` ready
 * probe — with the attempt identity supplied by the caller. It does not decide
 * recovery authority or roots, does not reconcile stops, holds no activation
 * deadline and claims no second attempt; the caller owns all of that.
 */
import {
  sandboxReconcileResultSchema,
  sandboxStatusResultSchema,
  type SandboxRecovery,
} from '../../shared/sandbox-control-protocol.js';

export type ReconcilePhase = 'drain' | 'ready' | 'commit';

export type ReconcileAttempt = {
  expectedWrapperInstanceId: string | undefined;
  episodeId: string;
  attempt: number;
  deadlineAt: number;
};

/** The transport response shape, compatible with the control `ResponseFrame`. */
export type ReconcileTransportResponse = {
  ok: boolean;
  result?: unknown;
};

export type ReconcileSendRequest = (input: {
  operation: 'sandbox.reconcile' | 'sandbox.status';
  payload: unknown;
  expectedWrapperInstanceId: string | undefined;
  deadlineAt: number;
  timeoutMs: number;
}) => Promise<ReconcileTransportResponse>;

export class ReconcilePortError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'ReconcilePortError';
  }
}

export type ReconcilePort = {
  sendPhase(
    input: ReconcileAttempt & { recovery: SandboxRecovery; phase: ReconcilePhase }
  ): Promise<void>;
  probeReady(input: ReconcileAttempt): Promise<boolean>;
};

export function createReconcilePort(sendRequest: ReconcileSendRequest): ReconcilePort {
  return {
    async sendPhase({
      expectedWrapperInstanceId,
      episodeId,
      attempt,
      deadlineAt,
      recovery,
      phase,
    }) {
      const response = await sendRequest({
        operation: 'sandbox.reconcile',
        expectedWrapperInstanceId,
        payload: { recovery, phase },
        deadlineAt,
        timeoutMs: Math.max(1, deadlineAt - Date.now()),
      });
      if (!response.ok) {
        throw new ReconcilePortError('Recovery was not acknowledged', true);
      }
      const acknowledgement = sandboxReconcileResultSchema.parse(response.result);
      if (
        acknowledgement.episodeId !== episodeId ||
        acknowledgement.attempt !== attempt ||
        acknowledgement.phase !== phase
      ) {
        throw new ReconcilePortError('Recovery acknowledgement changed', false);
      }
    },

    async probeReady({ expectedWrapperInstanceId, deadlineAt }) {
      const response = await sendRequest({
        operation: 'sandbox.status',
        expectedWrapperInstanceId,
        payload: {},
        deadlineAt,
        timeoutMs: Math.max(1, deadlineAt - Date.now()),
      });
      if (!response.ok) return false;
      return sandboxStatusResultSchema.parse(response.result).kiloReady === true;
    },
  };
}
