import type { KiloClawEnv } from '../../types';
import {
  OpenclawDoctorRunResponseSchema,
  GatewayControllerError,
} from '../gateway-controller-types';
import { callGatewayController, isErrorUnknownRoute } from './gateway';
import { getRuntimeId } from './state';
import type { InstanceMutableState } from './types';

type DoctorRunResponse = {
  ok: boolean;
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out';
  fix: boolean;
  output: string;
  exitCode: number | null;
  startedAt: string;
  completedAt: string;
  timedOut: boolean;
};

type DoctorRunConflictCode =
  | 'openclaw_doctor_instance_not_running'
  | 'openclaw_doctor_already_active';

/** Returned instead of throwing when a 409 would be lost crossing the DO RPC boundary. */
type DoctorRunConflict = {
  conflict: {
    code: DoctorRunConflictCode;
    error: string;
  };
};

function doctorRunConflict(code: DoctorRunConflictCode, error: string): DoctorRunConflict {
  return { conflict: { code, error } };
}

/**
 * Run `openclaw doctor [--fix] --non-interactive` via the machine's controller
 * HTTP API (NOT via the Fly Machines exec API).
 *
 * This is a synchronous buffered call: the response blocks until the child
 * exits or the controller's 120s hard cap trips. Returns null if the
 * controller predates this route (worker should surface that as a 404 with
 * code `controller_route_unavailable`).
 *
 * Returns a `{ conflict }` variant on 409 because custom error properties are
 * lost crossing the DO RPC boundary; only `.message` survives.
 */
export async function runDoctorViaController(
  state: InstanceMutableState,
  env: KiloClawEnv,
  fix: boolean
): Promise<DoctorRunResponse | DoctorRunConflict | null> {
  if (state.status !== 'running' || !getRuntimeId(state)) {
    return doctorRunConflict('openclaw_doctor_instance_not_running', 'Instance is not running');
  }

  try {
    return await callGatewayController(
      state,
      env,
      '/_kilo/doctor/run',
      'POST',
      OpenclawDoctorRunResponseSchema,
      { fix }
    );
  } catch (error) {
    if (isErrorUnknownRoute(error)) return null;
    if (error instanceof GatewayControllerError && error.status === 409) {
      return doctorRunConflict('openclaw_doctor_already_active', error.message);
    }
    throw error;
  }
}
