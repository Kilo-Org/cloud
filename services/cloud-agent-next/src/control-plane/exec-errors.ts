import type { ControlPlaneRequestError } from '../shared/control-plane-protocol.js';

export const EXECUTION_UNKNOWN_MESSAGE =
  'The command outcome is unknown because the sandbox connection was lost';

export type ExecutionUnknownFailure = { ok: false; error: ControlPlaneRequestError };

export function executionUnknownFailure(): ExecutionUnknownFailure {
  return {
    ok: false,
    error: {
      code: 'execution_unknown',
      message: EXECUTION_UNKNOWN_MESSAGE,
      retryable: false,
    },
  };
}
