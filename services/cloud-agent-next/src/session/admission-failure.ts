import {
  toAdmissionFailureCode,
  type CloudAgentAdmissionFailureCode,
} from '@kilocode/worker-utils/cloud-agent-failure';
import type { SessionMessageAdmissionResult } from '../execution/types.js';

export type InitialAdmissionFailure = {
  stage: 'initial_admission';
  code: 'initial_admission_rejected' | 'initial_queue_full' | 'invalid_initial_intent';
  admissionCode: CloudAgentAdmissionFailureCode;
};

/**
 * Maps a durable admission result to the bounded session-establishment failure
 * shape and preserves the underlying admission code so the telemetry classifier
 * can attribute the rejection instead of lumping it into an opaque catch-all.
 */
export function initialAdmissionFailure(
  result: Extract<SessionMessageAdmissionResult, { success: false }>
): InitialAdmissionFailure {
  const admissionCode = toAdmissionFailureCode(result.code);
  if (result.code === 'PENDING_QUEUE_FULL') {
    return { stage: 'initial_admission', code: 'initial_queue_full', admissionCode };
  }
  if (result.code === 'BAD_REQUEST') {
    return { stage: 'initial_admission', code: 'invalid_initial_intent', admissionCode };
  }
  return { stage: 'initial_admission', code: 'initial_admission_rejected', admissionCode };
}
