import type { ResponseFrame } from '../shared/sandbox-control-protocol.js';
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
  ensureReady(input: {
    ownerId: string;
    provider?: 'cloudflare' | 'vercel';
    kiloToken?: string;
    allowCreate?: boolean;
    acquisition?: SandboxAcquisition;
    billing?: SandboxBillingInput;
  }): Promise<{
    connection: ConnectionState;
    physical: PhysicalState;
    wrapperInstanceId?: string;
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
  request(input: SandboxControlOutboundRequest): Promise<ResponseFrame>;
};

export function sandboxControlRpc(env: Env, sandboxId: string): SandboxControlRpc {
  return env.SANDBOX_CONTROL.getByName(sandboxId);
}
