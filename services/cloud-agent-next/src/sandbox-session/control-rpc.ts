import type { VercelSandboxNetworkPolicy } from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import type { CredentialContainmentRequirements } from '../sandbox-control/physical-lifecycle.js';
import {
  SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
  sessionAbortPayloadSchema,
  type ResponseFrame,
  type SessionAttachPayload,
} from '../shared/sandbox-control-protocol.js';
import { DEFAULT_DO_RETRY_CONFIG, type DORetryScope } from '@kilocode/worker-utils';
import type { SandboxControlOutboundRequest } from '../sandbox-control/socket.js';
import type { AttachRouteInput } from '../sandbox-control/session-routes.js';
import type { ConnectionState, PhysicalState } from '../sandbox-control/status-projection.js';
import type {
  SandboxTerminalAccessInput,
  SandboxTerminalAccessResult,
} from '../sandbox-control/terminal-billing.js';
import type { SessionOperationAuthorization } from '../shared/sandbox-control-protocol.js';
import type { Env } from '../types.js';
import type { RuntimeQuarantineResult, SandboxAcquisition } from '../persistence/SandboxControl.js';
import type { SandboxBillingInput } from '../container-usage-context.js';
import { getSandboxControlStub } from '../sandbox-control/stub.js';
import { withDORetry } from '../utils/do-retry.js';

type SandboxControlRpc = {
  prepareSessionCredentials(input: {
    ownerId: string;
    sessionId: string;
  }): Promise<SessionAttachPayload>;
  ensureReady(input: {
    ownerId: string;
    sessionId: string;
    provider?: 'cloudflare' | 'vercel';
    allowCreate?: boolean;
    acquisition?: SandboxAcquisition;
    billing?: SandboxBillingInput;
    worktreeId?: string;
  }): Promise<{
    connection: ConnectionState;
    physical: PhysicalState;
    wrapperInstanceId?: string;
    operationResults?: true;
    attachment?: SessionAttachPayload;
  }>;
  getStatus(): Promise<{
    connection: ConnectionState;
    physical: PhysicalState;
    wrapperInstanceId?: string;
    operationResults?: true;
  }>;
  quarantineRuntime(input: {
    ownerId: string;
    sessionId: string;
    wrapperInstanceId: string;
    reason: string;
    nativeRuntimeId?: string;
    authorization?: SessionOperationAuthorization;
  }): Promise<RuntimeQuarantineResult>;
  attachSession(input: AttachRouteInput): Promise<unknown>;
  detachSession(sessionId: string): Promise<{ existed: boolean }>;
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
    quarantineRuntime: input => stub().quarantineRuntime(input),
    attachSession: input => stub().attachSession(input),
    detachSession: sessionId =>
      withDORetry(stub, control => control.detachSession(sessionId), 'detachSession'),
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
      return withDORetry(
        stub,
        control => control.request(input),
        'controlRequest',
        config(deadlineAt, retrySafe)
      );
    },
  };
}
