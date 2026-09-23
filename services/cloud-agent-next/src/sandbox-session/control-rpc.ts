import type {
  CloudflareContainersInstance,
  VercelSandboxResources,
} from '@kilocode/worker-utils/sandbox-allocation';
import type { VercelSandboxNetworkPolicy } from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import type { CredentialContainmentRequirements } from '../sandbox-state/model/allocation.js';
import {
  SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
  sessionAbortPayloadSchema,
  type ResponseFrame,
  type SessionAttachPayload,
} from '../shared/sandbox-control-protocol.js';
import { DEFAULT_DO_RETRY_CONFIG, type DORetryScope } from '@kilocode/worker-utils';
import type { SandboxControlOutboundRequest } from '../sandbox-control/socket.js';
import type { AttachRouteInput } from '../sandbox-control/session-routes.js';
import type { ConnectionState, PhysicalState } from '../shared/sandbox-status.js';
import type {
  SandboxTerminalAccessInput,
  SandboxTerminalAccessResult,
} from '../sandbox-control/terminal-billing.js';
import type { AgentSandboxProvider, Env } from '../types.js';
import type {
  ControlRuntimeCredentialProxyFence,
  SandboxAcquisition,
} from '../persistence/SandboxControl.js';
import type { SandboxBillingInput } from '../container-usage-context.js';
import { getSandboxControlStub } from '../sandbox-control/stub.js';
import { withDORetry } from '../utils/do-retry.js';
import { reconstructControlRequestError } from './control-dispatch.js';

type SandboxControlRpc = {
  prepareSessionCredentials(input: {
    ownerId: string;
    sessionId: string;
  }): Promise<SessionAttachPayload>;
  ensureReady(input: {
    ownerId: string;
    sessionId: string;
    provider?: AgentSandboxProvider;
    resources?: VercelSandboxResources;
    instance?: CloudflareContainersInstance;
    allowCreate?: boolean;
    acquisition?: SandboxAcquisition;
    billing?: SandboxBillingInput;
    worktreeId?: string;
  }): Promise<{
    connection: ConnectionState;
    physical: PhysicalState;
    wrapperInstanceId?: string;
    allocationIncarnation?: string;
    operationResults?: true;
    runtimeRecovery?: true;
    attachment?: SessionAttachPayload;
  }>;
  getStatus(): Promise<{
    connection: ConnectionState;
    physical: PhysicalState;
    wrapperInstanceId?: string;
    allocationIncarnation?: string;
    operationResults?: true;
    runtimeRecovery?: true;
  }>;
  getRuntimeCredentialProxyFence(input: {
    ownerId: string;
    sessionId: string;
    kiloSessionId: string;
    directory: string;
  }): Promise<ControlRuntimeCredentialProxyFence | null>;
  attachSession(input: AttachRouteInput): Promise<unknown>;
  bindRuntimeCredentialProxyHandle(input: {
    ownerId: string;
    sessionId: string;
    kiloSessionId: string;
    directory: string;
    handle: string;
  }): Promise<{ bound: true }>;
  detachSession(sessionId: string): Promise<{ existed: boolean }>;
  forgetSessionReference(sessionId: string): Promise<void>;
  validateTerminalAccess(input: SandboxTerminalAccessInput): Promise<SandboxTerminalAccessResult>;
  recordTerminalActivity(input: SandboxTerminalAccessInput): Promise<SandboxTerminalAccessResult>;
  updateNetworkPolicy(input: {
    ownerId: string;
    networkPolicy: VercelSandboxNetworkPolicy;
    requiredContainment: CredentialContainmentRequirements;
  }): Promise<void>;
  request(input: SandboxControlOutboundRequest): Promise<ResponseFrame>;
};

export function sandboxControlRpc(
  env: Env,
  sandboxId: string,
  scope?: DORetryScope
): SandboxControlRpc {
  const stub = () => getSandboxControlStub(env, sandboxId);
  const config = (
    deadlineAt = Date.now() + SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
    retrySafe = true
  ) => ({
    ...DEFAULT_DO_RETRY_CONFIG,
    maxAttempts: retrySafe ? DEFAULT_DO_RETRY_CONFIG.maxAttempts : 1,
    ...(retrySafe
      ? { scope: { ...scope, deadlineAt: Math.min(scope?.deadlineAt ?? Infinity, deadlineAt) } }
      : {}),
  });
  return {
    prepareSessionCredentials: input =>
      withDORetry(
        stub,
        control => control.prepareSessionCredentials(input),
        'prepareSessionCredentials'
      ),
    ensureReady: input => stub().ensureReady(input),
    getStatus: () => withDORetry(stub, control => control.getStatus(), 'getStatus', config()),
    getRuntimeCredentialProxyFence: input =>
      withDORetry(
        stub,
        control => control.getRuntimeCredentialProxyFence(input),
        'getRuntimeCredentialProxyFence',
        config()
      ),
    attachSession: input => stub().attachSession(input),
    bindRuntimeCredentialProxyHandle: input =>
      withDORetry(
        stub,
        control => control.bindRuntimeCredentialProxyHandle(input),
        'bindRuntimeCredentialProxyHandle'
      ),
    detachSession: sessionId =>
      withDORetry(stub, control => control.detachSession(sessionId), 'detachSession'),
    forgetSessionReference: sessionId =>
      withDORetry(
        stub,
        control => control.forgetSessionReference(sessionId),
        'forgetSessionReference',
        config()
      ),
    validateTerminalAccess: input =>
      withDORetry(stub, control => control.validateTerminalAccess(input), 'validateTerminalAccess'),
    recordTerminalActivity: input =>
      withDORetry(stub, control => control.recordTerminalActivity(input), 'recordTerminalActivity'),
    updateNetworkPolicy: input =>
      withDORetry(stub, control => control.updateNetworkPolicy(input), 'updateNetworkPolicy'),
    request: input => {
      const deadlineAt = Math.min(
        input.deadlineAt ?? Infinity,
        scope?.deadlineAt ?? Infinity,
        Date.now() + (input.timeoutMs ?? SANDBOX_CONTROL_REQUEST_TIMEOUT_MS)
      );
      const abort =
        input.operation === 'session.abort'
          ? sessionAbortPayloadSchema.safeParse(input.payload)
          : undefined;
      const retrySafe =
        [
          'sandbox.status',
          'session.sync',
          'session.operation.get',
          'session.operation.ack',
        ].includes(input.operation) ||
        (abort?.success === true &&
          abort.data.operationId !== undefined &&
          abort.data.messageId !== undefined);
      const pending = withDORetry(
        stub,
        control => control.request(input),
        'controlRequest',
        config(deadlineAt, retrySafe)
      ) as Promise<ResponseFrame>;
      return pending.catch((error: unknown): never => {
        throw reconstructControlRequestError(error);
      });
    },
  };
}
