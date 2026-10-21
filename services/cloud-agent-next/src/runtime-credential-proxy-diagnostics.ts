import { logger } from './logger.js';

/** Stable searchable tag for one failed runtime credential proxy request. */
export const RUNTIME_PROXY_REQUEST_FAILED_LOG_TAG = 'runtime_proxy_request_failed';

/**
 * Closed set of local authorization checks that can reject a runtime credential
 * proxy request before it reaches the upstream gateway. Retained evidence names
 * one bounded stage so a local rejection is distinguishable from an upstream
 * status.
 */
export const RUNTIME_PROXY_REJECTION_STAGES = [
  'handle',
  'context',
  'fence',
  'authorization',
  'grant',
  'token',
  'resolve',
] as const;
export type RuntimeProxyRejectionStage = (typeof RUNTIME_PROXY_REJECTION_STAGES)[number];

/**
 * Opaque correlation IDs already in scope at the proxy decision point. Never a
 * token, credential, URL, hostname, path, user identifier or response body.
 */
export type RuntimeProxyCorrelation = {
  sessionId?: string | null;
  kiloSessionId?: string | null;
  allocationId?: string | null;
  wrapperInstanceId?: string | null;
  connectionId?: string | null;
};

type RuntimeProxyRequestFailure =
  | { upstreamAttempted: false; rejectionStage: RuntimeProxyRejectionStage }
  | { upstreamAttempted: true; upstreamStatus: number; upstreamVercelRequestId?: string };

export function parseUpstreamVercelRequestId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length !== 44) return undefined;
  return /^[a-z]{3}[1-9]::[a-z]{3}[1-9]::([a-z0-9]{5}-[0-9]{13}-[a-f0-9]{12})$/.exec(value)?.[1];
}

/**
 * Emits exactly one bounded diagnostic for a failed runtime credential proxy
 * request: a named local rejection stage, or the upstream HTTP status when the
 * request reached the gateway. Successful requests must not call this.
 */
export function logRuntimeProxyRequestFailed(
  input: RuntimeProxyCorrelation & RuntimeProxyRequestFailure
): void {
  logger
    .withFields({
      logTag: RUNTIME_PROXY_REQUEST_FAILED_LOG_TAG,
      upstreamAttempted: input.upstreamAttempted,
      ...(input.upstreamAttempted
        ? {
            upstreamStatus: input.upstreamStatus,
            ...(input.upstreamVercelRequestId
              ? { upstreamVercelRequestId: input.upstreamVercelRequestId }
              : {}),
          }
        : { rejectionStage: input.rejectionStage }),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.kiloSessionId ? { kiloSessionId: input.kiloSessionId } : {}),
      ...(input.allocationId ? { allocationId: input.allocationId } : {}),
      ...(input.wrapperInstanceId ? { wrapperInstanceId: input.wrapperInstanceId } : {}),
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    })
    .warn('Runtime credential proxy request failed');
}
