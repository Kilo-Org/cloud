import type { ControlError } from '../../../src/shared/sandbox-control-protocol.js';

export type ControlHandlerResult =
  | { ok: true; result: unknown; admission?: never }
  | { ok: false; error: ControlError; admission?: 'not-admitted' };

export function rejectBeforeAdmission(
  code: ControlError['code'],
  message: string,
  retryable: boolean
): ControlHandlerResult {
  return { ok: false, error: { code, message, retryable }, admission: 'not-admitted' };
}
