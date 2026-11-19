import { TRPCError } from '@trpc/server';
import {
  RuntimeAuthorizationExpiredError,
  RuntimeAuthorizationRevokedError,
} from '@kilocode/worker-utils/runtime-authorization';
import { withDORetry } from '../../utils/do-retry.js';
import { logger } from '../../logger.js';
import type {
  ControlRuntimeCredentialProxyFence,
  ControlRuntimeCredentialProxyFenceScope,
  RuntimeProxyScopeViewUnavailableReason,
} from '../sandbox/sandbox-do.js';
import type { ScopeGrantView } from '../sandbox/scope-view.js';

/** Stable searchable tag for one failed runtime credential proxy fence read. */
export const RUNTIME_PROXY_FENCE_LOG_TAG = 'runtime_proxy_fence_failed';

/** The exact branch that failed: a stale accepted handle, or the Sandbox DO RPC. */
export type RuntimeProxyFenceFailureStage =
  | RuntimeProxyScopeViewUnavailableReason
  | 'sandbox_rpc_failed';

export type RuntimeProxyFenceCorrelation = {
  sessionId?: string;
  kiloSessionId?: string;
  sandboxId?: string;
  allocationId?: string;
};

type RuntimeProxyFencePeer = {
  getRuntimeCredentialProxyFence(input: {
    ownerId: string;
    sessionId: string;
    kiloSessionId: string;
    directory: string;
    handle: string;
  }): Promise<ControlRuntimeCredentialProxyFenceScope | null>;
};

/**
 * An expected stale accepted handle: the handle is not valid for the caller's
 * grant. The caller maps this to a 401 denial and never serves the scope view.
 */
export class RuntimeProxyScopeViewDenialError extends Error {
  constructor(readonly reason: RuntimeProxyScopeViewUnavailableReason) {
    super('Runtime credential proxy scope view unavailable');
    this.name = 'RuntimeProxyScopeViewDenialError';
  }
}

export function isRuntimeProxyScopeViewDenialError(
  error: unknown
): error is RuntimeProxyScopeViewDenialError {
  return error instanceof RuntimeProxyScopeViewDenialError;
}

/**
 * A Sandbox DO transport failure. SERVICE_UNAVAILABLE keeps the facade's
 * retryable 503 while shouldCaptureCloudAgentException drops it, so an expected
 * transport failure is not reported as an unhandled internal DO exception.
 */
export class RuntimeProxyFenceTransportError extends TRPCError {
  constructor(cause: unknown) {
    super({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Runtime credential proxy fence unavailable',
      cause,
    });
    this.name = 'RuntimeProxyFenceTransportError';
  }
}

/**
 * How the Session DO answers a failed local grant resolution.
 *
 * - `deny`: a 401. The handle is not valid for the caller's grant, so neither
 *   the scope view nor a shared-scope fallback is served.
 * - `retry`: rethrow, and the facade answers its retryable 503
 *   `Credential unavailable`.
 * - `fallback`: only a revoked or expired local runtime authorization, which a
 *   surviving member of the canonical scope may still serve with its own
 *   backing credential.
 */
export type RuntimeProxyFenceErrorOutcome = 'deny' | 'retry' | 'fallback';

/**
 * Classifies a failure from the local grant resolution. The exact contract:
 *
 * - `RuntimeProxyScopeViewDenialError` -> `deny`.
 * - `RuntimeProxyFenceTransportError` -> `retry`.
 * - `RuntimeAuthorizationRevokedError` or `RuntimeAuthorizationExpiredError` ->
 *   `fallback`.
 * - Every other value, including `null` and non-`Error` throws -> `retry`.
 *
 * The classification is exhaustive and the default is retryable. A storage or
 * database fault is not evidence about the credential, so it keeps the
 * retryable 503 `Credential unavailable` answer and is not reported as a
 * denial. Only the two authorization outcomes above use the scope fallback.
 *
 * Matching is by `instanceof`, so a value that merely carries one of these
 * names is not treated as an authorization failure.
 */
export function classifyRuntimeProxyFenceError(error: unknown): RuntimeProxyFenceErrorOutcome {
  if (isRuntimeProxyScopeViewDenialError(error)) return 'deny';
  if (error instanceof RuntimeProxyFenceTransportError) return 'retry';
  if (
    error instanceof RuntimeAuthorizationRevokedError ||
    error instanceof RuntimeAuthorizationExpiredError
  )
    return 'fallback';
  return 'retry';
}

export function logRuntimeProxyFenceFailure(
  input: RuntimeProxyFenceCorrelation & { stage: RuntimeProxyFenceFailureStage }
): void {
  logger
    .withFields({
      logTag: RUNTIME_PROXY_FENCE_LOG_TAG,
      stage: input.stage,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.kiloSessionId ? { kiloSessionId: input.kiloSessionId } : {}),
      ...(input.sandboxId ? { sandboxId: input.sandboxId } : {}),
      ...(input.allocationId ? { allocationId: input.allocationId } : {}),
    })
    .warn('Runtime credential proxy fence resolution failed');
}

/**
 * Reads the caller's runtime credential proxy fence from the Sandbox DO with a
 * bounded retry. A stale accepted handle throws a denial; a transport failure
 * throws a retryable error. Neither is an unhandled internal exception. Null
 * means no fence is available and the caller keeps its existing fallback.
 */
export async function readRuntimeProxyFence(input: {
  getPeer: () => RuntimeProxyFencePeer | null;
  request: {
    ownerId: string;
    sessionId: string;
    kiloSessionId: string;
    directory: string;
    handle: string;
  };
  correlation: RuntimeProxyFenceCorrelation;
}): Promise<{ fence: ControlRuntimeCredentialProxyFence; scopeView?: ScopeGrantView } | null> {
  const peer = input.getPeer();
  if (peer === null) return null;
  let resolution: ControlRuntimeCredentialProxyFenceScope | null;
  try {
    resolution = await withDORetry(
      () => input.getPeer() ?? peer,
      current => current.getRuntimeCredentialProxyFence(input.request),
      'getRuntimeCredentialProxyFence'
    );
  } catch (error) {
    logRuntimeProxyFenceFailure({ ...input.correlation, stage: 'sandbox_rpc_failed' });
    throw new RuntimeProxyFenceTransportError(error);
  }
  if (resolution === null) return null;
  if (resolution.scopeViewUnavailable !== undefined) {
    // Security: a mismatched or missing canonical grant must never serve the scope view.
    logRuntimeProxyFenceFailure({
      ...input.correlation,
      allocationId: resolution.allocationId,
      stage: resolution.scopeViewUnavailable,
    });
    throw new RuntimeProxyScopeViewDenialError(resolution.scopeViewUnavailable);
  }
  const { scopeView, ...fence } = resolution;
  return scopeView === undefined ? { fence } : { fence, scopeView };
}
