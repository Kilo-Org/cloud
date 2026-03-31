import type { KiloClawEnv } from '../../types';
import {
  KiloCliRunStartResponseSchema,
  KiloCliRunStatusResponseSchema,
  GatewayCommandResponseSchema,
} from '../gateway-controller-types';
import { callGatewayController, isErrorUnknownRoute } from './gateway';
import type { InstanceMutableState } from './types';

type KiloCliRunStartResponse = {
  ok: boolean;
  startedAt: string;
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
 */
export async function startKiloCliRun(
  state: InstanceMutableState,
  env: KiloClawEnv,
  prompt: string
): Promise<KiloCliRunStartResponse | null> {
  if (state.status !== 'running' || !state.flyMachineId) {
    throw Object.assign(new Error('Instance is not running'), { status: 409 });
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
  if (state.status !== 'running' || !state.flyMachineId) {
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
  if (state.status !== 'running' || !state.flyMachineId) {
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
