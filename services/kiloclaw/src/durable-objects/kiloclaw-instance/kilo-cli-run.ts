import type { KiloClawEnv } from '../../types';
import {
  KiloCliRunStartResponseSchema,
  KiloCliRunStatusResponseSchema,
  GatewayCommandResponseSchema,
  GatewayControllerError,
} from '../gateway-controller-types';
import { callGatewayController, isErrorUnknownRoute } from './gateway';
import { getRuntimeId } from './state';
import type { InstanceMutableState } from './types';

type KiloCliRunStartResponse = {
  ok: boolean;
  startedAt: string;
};

type KiloCliRunConflictCode =
  | 'kilo_cli_run_instance_not_running'
  | 'kilo_cli_run_already_active'
  | 'kilo_cli_run_no_active_run';

/** Returned instead of throwing when a 409 would be lost crossing the DO RPC boundary. */
type KiloCliRunConflict = {
  conflict: {
    code: KiloCliRunConflictCode;
    error: string;
  };
};

function kiloCliRunConflict(code: KiloCliRunConflictCode, error: string): KiloCliRunConflict {
  return { conflict: { code, error } };
}

/**
 * Older controllers can return 409 without a structured code. For start, the
 * legacy 409 contract meant "a run is already active", so preserve that
 * operation-specific meaning instead of using a shared default.
 */
function startConflictCodeFromController(error: GatewayControllerError): KiloCliRunConflictCode {
  if (error.code === 'kilo_cli_run_already_active') return error.code;
  if (error.code === 'kilo_cli_run_no_active_run') return error.code;
  return 'kilo_cli_run_already_active';
}

/**
 * Older controllers can return 409 without a structured code. For cancel, the
 * legacy 409 contract meant "there is no active run to cancel", so this must
 * not share start's fallback or stale running rows would keep the wrong cause.
 */
function cancelConflictCodeFromController(error: GatewayControllerError): KiloCliRunConflictCode {
  if (error.code === 'kilo_cli_run_already_active') return error.code;
  if (error.code === 'kilo_cli_run_no_active_run') return error.code;
  return 'kilo_cli_run_no_active_run';
}

type KiloCliRunStatusResponse = {
  hasRun: boolean;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | null;
  output: string | null;
  exitCode: number | null;
  startedAt: string | null;
  completedAt: string | null;
  prompt: string | null;
};

/**
 * Start a `kilo run --auto` process on the controller.
 *
 * Returns a `{ conflict: { code, error } }` variant instead of throwing on 409 because
 * custom error properties (like `.status`) are lost crossing the DO RPC
 * boundary — only `.message` survives. Return values serialize correctly.
 */
export async function startKiloCliRun(
  state: InstanceMutableState,
  env: KiloClawEnv,
  prompt: string
): Promise<KiloCliRunStartResponse | KiloCliRunConflict | null> {
  if (state.status !== 'running' || !getRuntimeId(state)) {
    return kiloCliRunConflict('kilo_cli_run_instance_not_running', 'Instance is not running');
  }

  try {
    return await callGatewayController(
      state,
      env,
      '/_kilo/cli-run/start',
      'POST',
      KiloCliRunStartResponseSchema,
      { prompt }
    );
  } catch (error) {
    if (isErrorUnknownRoute(error)) return null;
    if (error instanceof GatewayControllerError && error.status === 409) {
      return kiloCliRunConflict(startConflictCodeFromController(error), error.message);
    }
    throw error;
  }
}

/**
 * Get the status of the current kilo CLI run on the controller.
 */
export async function getKiloCliRunStatus(
  state: InstanceMutableState,
  env: KiloClawEnv
): Promise<KiloCliRunStatusResponse> {
  if (state.status !== 'running' || !getRuntimeId(state)) {
    return {
      hasRun: false,
      status: null,
      output: null,
      exitCode: null,
      startedAt: null,
      completedAt: null,
      prompt: null,
    };
  }

  return callGatewayController(
    state,
    env,
    '/_kilo/cli-run/status',
    'GET',
    KiloCliRunStatusResponseSchema
  );
}

/**
 * Cancel the active kilo CLI run on the controller.
 *
 * Returns a `{ conflict: { code, error } }` variant instead of throwing on not-running because
 * custom error properties (like `.status`) are lost crossing the DO RPC
 * boundary — only `.message` survives. Return values serialize correctly.
 */
export async function cancelKiloCliRun(
  state: InstanceMutableState,
  env: KiloClawEnv
): Promise<{ ok: boolean } | KiloCliRunConflict> {
  if (state.status !== 'running' || !getRuntimeId(state)) {
    return kiloCliRunConflict('kilo_cli_run_instance_not_running', 'Instance is not running');
  }

  try {
    return await callGatewayController(
      state,
      env,
      '/_kilo/cli-run/cancel',
      'POST',
      GatewayCommandResponseSchema
    );
  } catch (error) {
    if (error instanceof GatewayControllerError && error.status === 409) {
      return kiloCliRunConflict(cancelConflictCodeFromController(error), error.message);
    }
    throw error;
  }
}
