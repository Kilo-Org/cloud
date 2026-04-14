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

/** Returned instead of throwing when a 409 would be lost crossing the DO RPC boundary. */
type KiloCliRunConflict = {
  conflict: string;
};

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
 * Returns a `{ conflict }` variant instead of throwing on 409 because
 * custom error properties (like `.status`) are lost crossing the DO RPC
 * boundary — only `.message` survives. Return values serialize correctly.
 */
export async function startKiloCliRun(
  state: InstanceMutableState,
  env: KiloClawEnv,
  prompt: string
): Promise<KiloCliRunStartResponse | KiloCliRunConflict | null> {
  if (state.status !== 'running' || !getRuntimeId(state)) {
    return { conflict: 'Instance is not running' };
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
      return { conflict: error.message };
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
 */
export async function cancelKiloCliRun(
  state: InstanceMutableState,
  env: KiloClawEnv
): Promise<{ ok: boolean }> {
  if (state.status !== 'running' || !getRuntimeId(state)) {
    throw Object.assign(new Error('Instance is not running'), { status: 409 });
  }

  return callGatewayController(
    state,
    env,
    '/_kilo/cli-run/cancel',
    'POST',
    GatewayCommandResponseSchema
  );
}
