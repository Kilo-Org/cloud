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
  }): Promise<{
    connection: ConnectionState;
    physical: PhysicalState;
    wrapperInstanceId?: string;
    attachment?: SessionAttachPayload;
  }>;
  getStatus(): Promise<{
    connection: ConnectionState;
    physical: PhysicalState;
    wrapperInstanceId?: string;
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
  return env.SANDBOX_CONTROL.getByName(sandboxId);
}
