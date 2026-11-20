import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DO_RETRY_CONFIG } from '@kilocode/worker-utils';
import { shouldCaptureCloudAgentException } from '../../sentry.js';
import {
  classifyRuntimeProxyFenceError,
  isRuntimeProxyScopeViewDenialError,
  logRuntimeProxyFenceFailure,
  readRuntimeProxyFence,
  RUNTIME_PROXY_FENCE_LOG_TAG,
  RuntimeProxyFenceTransportError,
  RuntimeProxyScopeViewDenialError,
} from './runtime-proxy-fence.js';
import type {
  ControlRuntimeCredentialProxyFenceScope,
  RuntimeProxyScopeViewUnavailableReason,
} from '../sandbox/sandbox-do.js';
import type { ScopeGrantView } from '../sandbox/scope-view.js';

const { loggerWarnMock, loggerWithFieldsMock } = vi.hoisted(() => ({
  loggerWarnMock: vi.fn(),
  loggerWithFieldsMock: vi.fn(),
}));

vi.mock('../../logger.js', () => {
  const logger = {
    withFields: loggerWithFieldsMock,
    warn: loggerWarnMock,
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
  loggerWithFieldsMock.mockReturnValue(logger);
  return { logger };
});

beforeEach(() => {
  loggerWarnMock.mockClear();
  loggerWithFieldsMock.mockClear();
});

const fence = {
  plane: 'control',
  allocationId: 'allocation_1',
  providerInstanceId: 'provider_1',
  connectionId: 'connection_1',
  wrapperInstanceId: 'wrapper_1',
} as const;

const scopeView: ScopeGrantView = {
  scopeId: 'scope_1',
  expectedOrganizationId: null,
  memberRootKiloSessionIds: ['kilo_1'],
};

const request = {
  ownerId: 'user_1',
  sessionId: 'workspace_1',
  kiloSessionId: 'kilo_1',
  directory: '/workspace/repo',
  handle: 'handle-secret',
};

const correlation = { sessionId: 'workspace_1', kiloSessionId: 'kilo_1', sandboxId: 'sbx_1' };

function peerReturning(resolution: ControlRuntimeCredentialProxyFenceScope | null) {
  return { getRuntimeCredentialProxyFence: vi.fn().mockResolvedValue(resolution) };
}

function peerFailing(error: unknown) {
  return { getRuntimeCredentialProxyFence: vi.fn().mockRejectedValue(error) };
}

function fenceLogCalls() {
  return loggerWithFieldsMock.mock.calls
    .map(call => call[0] as Record<string, unknown>)
    .filter(fields => fields.logTag === RUNTIME_PROXY_FENCE_LOG_TAG);
}

describe('readRuntimeProxyFence', () => {
  it('returns the fence and scope view on success without logging a failure', async () => {
    const peer = peerReturning({ ...fence, scopeView });
    const result = await readRuntimeProxyFence({ getPeer: () => peer, request, correlation });
    expect(result).toEqual({ fence, scopeView });
    expect(peer.getRuntimeCredentialProxyFence).toHaveBeenCalledWith(request);
    expect(fenceLogCalls()).toHaveLength(0);
  });

  it('returns the fence without a scope view when the handle is not adopted', async () => {
    const peer = peerReturning({ ...fence });
    const result = await readRuntimeProxyFence({ getPeer: () => peer, request, correlation });
    expect(result).toEqual({ fence });
    expect(fenceLogCalls()).toHaveLength(0);
  });

  it('returns null when the Sandbox DO has no fence', async () => {
    const peer = peerReturning(null);
    const result = await readRuntimeProxyFence({ getPeer: () => peer, request, correlation });
    expect(result).toBeNull();
    expect(fenceLogCalls()).toHaveLength(0);
  });

  it('returns null without an RPC when there is no sandbox peer', async () => {
    const result = await readRuntimeProxyFence({ getPeer: () => null, request, correlation });
    expect(result).toBeNull();
    expect(fenceLogCalls()).toHaveLength(0);
  });

  it.each([
    ['scope_mismatch', 'scope_mismatch'],
    ['missing_canonical_grant', 'missing_canonical_grant'],
  ] as const)(
    'denies a stale accepted handle (%s) without serving the scope view',
    async (reason: RuntimeProxyScopeViewUnavailableReason, stage: string) => {
      const peer = peerReturning({ ...fence, scopeView, scopeViewUnavailable: reason });
      const promise = readRuntimeProxyFence({ getPeer: () => peer, request, correlation });
      await expect(promise).rejects.toBeInstanceOf(RuntimeProxyScopeViewDenialError);
      const error = await promise.catch((caught: unknown) => caught);
      expect(isRuntimeProxyScopeViewDenialError(error)).toBe(true);
      expect((error as RuntimeProxyScopeViewDenialError).reason).toBe(reason);
      expect(classifyRuntimeProxyFenceError(error)).toBe('deny');

      const logs = fenceLogCalls();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        logTag: RUNTIME_PROXY_FENCE_LOG_TAG,
        stage,
        sessionId: 'workspace_1',
        allocationId: 'allocation_1',
      });
      expect(JSON.stringify(logs[0])).not.toContain(request.handle);
    }
  );

  it('retries a retryable Sandbox DO RPC failure within the bound, then reports transport', async () => {
    const rpcError = Object.assign(new Error('sandbox rpc reset'), { retryable: true });
    const peer = peerFailing(rpcError);
    const promise = readRuntimeProxyFence({ getPeer: () => peer, request, correlation });
    await expect(promise).rejects.toBeInstanceOf(RuntimeProxyFenceTransportError);
    expect(peer.getRuntimeCredentialProxyFence).toHaveBeenCalledTimes(
      DEFAULT_DO_RETRY_CONFIG.maxAttempts
    );
    const error = await promise.catch((caught: unknown) => caught);
    expect(classifyRuntimeProxyFenceError(error)).toBe('retry');
    expect((error as RuntimeProxyFenceTransportError).cause).toBe(rpcError);

    const logs = fenceLogCalls();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      logTag: RUNTIME_PROXY_FENCE_LOG_TAG,
      stage: 'sandbox_rpc_failed',
      sessionId: 'workspace_1',
    });
    expect(JSON.stringify(logs[0])).not.toContain(request.handle);
  });

  it('does not retry a non-retryable Sandbox DO RPC failure', async () => {
    const peer = peerFailing(new Error('sandbox rpc rejected'));
    const promise = readRuntimeProxyFence({ getPeer: () => peer, request, correlation });
    await expect(promise).rejects.toBeInstanceOf(RuntimeProxyFenceTransportError);
    expect(peer.getRuntimeCredentialProxyFence).toHaveBeenCalledTimes(1);
    expect(fenceLogCalls()[0]).toMatchObject({ stage: 'sandbox_rpc_failed' });
  });
});

describe('classifyRuntimeProxyFenceError', () => {
  it('denies a scope-view denial', () => {
    expect(
      classifyRuntimeProxyFenceError(new RuntimeProxyScopeViewDenialError('scope_mismatch'))
    ).toBe('deny');
  });

  it('retries a fence transport failure', () => {
    expect(
      classifyRuntimeProxyFenceError(new RuntimeProxyFenceTransportError(new Error('x')))
    ).toBe('retry');
  });

  it('keeps the scope fallback for any other error', () => {
    expect(classifyRuntimeProxyFenceError(new Error('authorization revoked'))).toBe('fallback');
    expect(classifyRuntimeProxyFenceError(null)).toBe('fallback');
  });
});

describe('expected fence failures are not unhandled internal exceptions', () => {
  it('does not capture the retryable transport failure in Sentry', () => {
    const error = new RuntimeProxyFenceTransportError(new Error('sandbox rpc reset'));
    expect(error.code).toBe('SERVICE_UNAVAILABLE');
    expect(shouldCaptureCloudAgentException(error)).toBe(false);
  });
});

describe('logRuntimeProxyFenceFailure', () => {
  it('emits only bounded correlation fields, never the handle', () => {
    logRuntimeProxyFenceFailure({
      stage: 'scope_mismatch',
      sessionId: 'workspace_1',
      kiloSessionId: 'kilo_1',
      sandboxId: 'sbx_1',
      allocationId: 'allocation_1',
    });
    expect(loggerWithFieldsMock).toHaveBeenCalledWith({
      logTag: RUNTIME_PROXY_FENCE_LOG_TAG,
      stage: 'scope_mismatch',
      sessionId: 'workspace_1',
      kiloSessionId: 'kilo_1',
      sandboxId: 'sbx_1',
      allocationId: 'allocation_1',
    });
    expect(loggerWarnMock).toHaveBeenCalledWith('Runtime credential proxy fence resolution failed');
  });
});
