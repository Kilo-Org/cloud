import { isWorkspaceFailureSubtype } from '@kilocode/worker-utils/cloud-agent-failure';
import {
  WRAPPER_READY_ERROR_DETAIL_MAX_LENGTH,
  WRAPPER_READY_ERROR_MESSAGE_MAX_LENGTH,
  type WrapperSessionReadyErrorResponse,
} from '../shared/wrapper-bootstrap.js';

export type FlattenedWrapperSessionReadyError = {
  error: WrapperSessionReadyErrorResponse['error']['code'];
  message: string;
} & Omit<WrapperSessionReadyErrorResponse['error'], 'code' | 'message'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'string' && value[key].length > 0;
}

export function parseWrapperSessionReadyErrorResponse(
  value: unknown
): FlattenedWrapperSessionReadyError | undefined {
  if (!isRecord(value) || !hasString(value, 'error') || !hasString(value, 'message'))
    return undefined;
  if (
    typeof value.message !== 'string' ||
    value.message.length > WRAPPER_READY_ERROR_MESSAGE_MAX_LENGTH
  ) {
    return undefined;
  }
  if (value.subtype !== undefined && !isWorkspaceFailureSubtype(value.subtype)) return undefined;
  if (
    value.detail !== undefined &&
    (typeof value.detail !== 'string' ||
      value.detail.length > WRAPPER_READY_ERROR_DETAIL_MAX_LENGTH)
  ) {
    return undefined;
  }
  if (value.retryable !== undefined && typeof value.retryable !== 'boolean') return undefined;
  if (value.wrapperRunId !== undefined && typeof value.wrapperRunId !== 'string') return undefined;
  if (
    value.error !== 'INVALID_REQUEST' &&
    value.error !== 'WRAPPER_FINALIZING' &&
    value.error !== 'WORKSPACE_SETUP_FAILED' &&
    value.error !== 'KILO_SERVER_FAILED'
  ) {
    return undefined;
  }
  return {
    error: value.error,
    message: value.message,
    ...(value.subtype !== undefined ? { subtype: value.subtype } : {}),
    ...(value.detail !== undefined ? { detail: value.detail } : {}),
    ...(value.retryable !== undefined ? { retryable: value.retryable } : {}),
    ...(value.wrapperRunId !== undefined ? { wrapperRunId: value.wrapperRunId } : {}),
  };
}

export function isWrapperSessionReadyErrorResponse(
  value: unknown
): value is FlattenedWrapperSessionReadyError {
  return parseWrapperSessionReadyErrorResponse(value) !== undefined;
}
