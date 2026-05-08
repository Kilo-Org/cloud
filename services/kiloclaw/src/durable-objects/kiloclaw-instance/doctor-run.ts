import type { KiloClawEnv } from '../../types';
import {
  OpenclawDoctorStartResponseSchema,
  OpenclawDoctorStatusResponseSchema,
  OpenclawDoctorCancelResponseSchema,
  GatewayControllerError,
} from '../gateway-controller-types';
import { callGatewayController, isErrorUnknownRoute } from './gateway';
import { getRuntimeId } from './state';
import type { InstanceMutableState } from './types';

type DoctorStartResponse = {
  ok: boolean;
  runId: string;
  startedAt: string;
};

type DoctorStatusResponse = {
  hasRun: boolean;
  runId: string | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | null;
  fix: boolean | null;
  output: string | null;
  outputBytes: number;
  outputTruncated: boolean;
  exitCode: number | null;
  startedAt: string | null;
  completedAt: string | null;
  timedOut: boolean;
};

type DoctorCancelResponse = {
  ok: boolean;
};

type DoctorRunConflictCode =
  | 'openclaw_doctor_instance_not_running'
  | 'openclaw_doctor_already_active'
  | 'openclaw_doctor_no_active_run';

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

function notRunningConflict(state: InstanceMutableState): DoctorRunConflict | null {
  if (state.status !== 'running' || !getRuntimeId(state)) {
    return doctorRunConflict('openclaw_doctor_instance_not_running', 'Instance is not running');
  }
  return null;
}

function controllerConflict(error: GatewayControllerError): DoctorRunConflict | null {
  if (error.status !== 409) return null;
  if (error.code === 'openclaw_doctor_already_active') {
    return doctorRunConflict('openclaw_doctor_already_active', error.message);
  }
  if (error.code === 'openclaw_doctor_no_active_run') {
    return doctorRunConflict('openclaw_doctor_no_active_run', error.message);
  }
  return null;
}

/** Start `openclaw doctor [--fix] --non-interactive` via the machine controller. */
export async function startDoctorViaController(
  state: InstanceMutableState,
  env: KiloClawEnv,
  fix: boolean
): Promise<DoctorStartResponse | DoctorRunConflict | null> {
  const conflict = notRunningConflict(state);
  if (conflict) return conflict;

  try {
    return await callGatewayController(
      state,
      env,
      '/_kilo/doctor/start',
      'POST',
      OpenclawDoctorStartResponseSchema,
      { fix }
    );
  } catch (error) {
    if (isErrorUnknownRoute(error)) return null;
    if (error instanceof GatewayControllerError) {
      const conflictResponse = controllerConflict(error);
      if (conflictResponse) return conflictResponse;
    }
    throw error;
  }
}

/** Fetch the current/last controller doctor run status and output. */
export async function getDoctorViaControllerStatus(
  state: InstanceMutableState,
  env: KiloClawEnv
): Promise<DoctorStatusResponse | DoctorRunConflict | null> {
  const conflict = notRunningConflict(state);
  if (conflict) return conflict;

  try {
    return await callGatewayController(
      state,
      env,
      '/_kilo/doctor/status',
      'GET',
      OpenclawDoctorStatusResponseSchema
    );
  } catch (error) {
    if (isErrorUnknownRoute(error)) return null;
    if (error instanceof GatewayControllerError) {
      const conflictResponse = controllerConflict(error);
      if (conflictResponse) return conflictResponse;
    }
    throw error;
  }
}

/** Cancel the active controller doctor run, if any. */
export async function cancelDoctorViaController(
  state: InstanceMutableState,
  env: KiloClawEnv
): Promise<DoctorCancelResponse | DoctorRunConflict | null> {
  const conflict = notRunningConflict(state);
  if (conflict) return conflict;

  try {
    return await callGatewayController(
      state,
      env,
      '/_kilo/doctor/cancel',
      'POST',
      OpenclawDoctorCancelResponseSchema
    );
  } catch (error) {
    if (isErrorUnknownRoute(error)) return null;
    if (error instanceof GatewayControllerError) {
      const conflictResponse = controllerConflict(error);
      if (conflictResponse) return conflictResponse;
    }
    throw error;
  }
}
