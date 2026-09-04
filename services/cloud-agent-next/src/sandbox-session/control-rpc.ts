import type { VercelSandboxNetworkPolicy } from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import type { CredentialContainmentRequirements } from '../sandbox-control/physical-lifecycle.js';
import type { ResponseFrame, SessionAttachPayload } from '../shared/sandbox-control-protocol.js';
import type { SandboxControlOutboundRequest } from '../sandbox-control/socket.js';
import type { AttachRouteInput } from '../sandbox-control/session-routes.js';
import type { ConnectionState, PhysicalState } from '../sandbox-control/status-projection.js';
import type {
  SandboxTerminalAccessInput,
  SandboxTerminalAccessResult,
} from '../sandbox-control/terminal-billing.js';
import type { Env } from '../types.js';
import type { SandboxAcquisition } from '../persistence/SandboxControl.js';
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
  }): Promise<{ quarantined: boolean }>;
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

export function sandboxControlRpc(env: Env, sandboxId: string): SandboxControlRpc {
  const stub = () => getSandboxControlStub(env, sandboxId);
  return {
    prepareSessionCredentials: input =>
      withDORetry(
        stub,
        control => control.prepareSessionCredentials(input),
        'prepareSessionCredentials'
      ),
    ensureReady: input => stub().ensureReady(input),
    getStatus: () => stub().getStatus(),
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
    request: input => stub().request(input),
  };
}
