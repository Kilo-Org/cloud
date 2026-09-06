import {
  SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS,
  sessionScopedStopAbortPayloadSchema,
  type SessionAbortPayload,
} from '../shared/sandbox-control-protocol.js';

export function parseScopedStopMaintenance(payload: unknown, now = Date.now()) {
  const parsed = sessionScopedStopAbortPayloadSchema.safeParse(payload);
  if (
    !parsed.success ||
    parsed.data.cleanupDeadlineAt <= now ||
    parsed.data.cleanupDeadlineAt > now + SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS
  )
    return undefined;
  return parsed.data;
}

export function hasScopedStopMaintenanceFields(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    (Object.hasOwn(payload, 'operationId') || Object.hasOwn(payload, 'cleanupDeadlineAt'))
  );
}

export function stopAbortWirePayload(
  payload: SessionAbortPayload,
  supportsScopedStopAbort: boolean
): SessionAbortPayload {
  if (supportsScopedStopAbort) return payload;
  return payload.messageId ? { messageId: payload.messageId } : {};
}
