import 'server-only';
import { TRPC_ERROR_CODES_BY_KEY, type TRPC_ERROR_CODE_KEY } from '@trpc/server/rpc';
import { readCloudAgentErrorFields } from '@kilocode/app-shared/cloud-agent-error';

/**
 * The one worker status/code table and error-code reader for this directory:
 * every cloud-agent caller here resolves an upstream failure through
 * `readCloudAgentErrorCode` rather than reading the error's bags itself.
 *
 * A `ReadonlyMap` rather than `Record<number, …>` because a status that is not
 * in the table must read as absent, and a numeric `Record` lookup types as
 * present for every key.
 */
export const HTTP_STATUS_TO_TRPC_CODE: ReadonlyMap<number, TRPC_ERROR_CODE_KEY> = new Map([
  [400, 'BAD_REQUEST'],
  [401, 'UNAUTHORIZED'],
  [402, 'PAYMENT_REQUIRED'],
  [403, 'FORBIDDEN'],
  [404, 'NOT_FOUND'],
  [408, 'TIMEOUT'],
  [409, 'CONFLICT'],
  [412, 'PRECONDITION_FAILED'],
  [422, 'UNPROCESSABLE_CONTENT'],
  [429, 'TOO_MANY_REQUESTS'],
  [500, 'INTERNAL_SERVER_ERROR'],
  [502, 'BAD_GATEWAY'],
  [503, 'SERVICE_UNAVAILABLE'],
  [504, 'GATEWAY_TIMEOUT'],
]);

export function isTRPCErrorCode(code: string): code is TRPC_ERROR_CODE_KEY {
  return Object.hasOwn(TRPC_ERROR_CODES_BY_KEY, code);
}

/**
 * The worker's own code wins when the caller accepts it; otherwise a known HTTP
 * status stands in for it. `accepted` is a parameter so each caller declares
 * which failures it exposes and the reader never widens that set: a code or a
 * mapped status outside it is reported as no code at all, which is how callers
 * that handle only a few failures stay unable to leak the others.
 */
export function readCloudAgentErrorCode(
  error: unknown,
  accepted: ReadonlySet<TRPC_ERROR_CODE_KEY>
): TRPC_ERROR_CODE_KEY | undefined {
  const { code, httpStatus } = readCloudAgentErrorFields(error);

  if (code !== undefined && isTRPCErrorCode(code) && accepted.has(code)) return code;
  if (httpStatus === undefined) return undefined;

  const mapped = HTTP_STATUS_TO_TRPC_CODE.get(httpStatus);
  return mapped !== undefined && accepted.has(mapped) ? mapped : undefined;
}
