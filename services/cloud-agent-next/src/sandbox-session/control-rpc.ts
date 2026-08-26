import type { ResponseFrame } from '../shared/sandbox-control-protocol.js';
import type { SandboxControlOutboundRequest } from '../sandbox-control/socket.js';
import type { AttachRouteInput } from '../sandbox-control/session-routes.js';
import type { ConnectionState, PhysicalState } from '../sandbox-control/status-projection.js';
import type { Env } from '../types.js';

type SandboxControlRpc = {
  ensureReady(input: {
    ownerId: string;
    provider?: 'cloudflare' | 'vercel';
    kiloToken?: string;
    allowCreate?: boolean;
  }): Promise<{ connection: ConnectionState; physical: PhysicalState }>;
  getStatus(): Promise<{ connection: ConnectionState; physical: PhysicalState }>;
  attachSession(input: AttachRouteInput): Promise<unknown>;
  request(input: SandboxControlOutboundRequest): Promise<ResponseFrame>;
};

export function sandboxControlRpc(env: Env, sandboxId: string): SandboxControlRpc {
  return env.SANDBOX_CONTROL.getByName(sandboxId) as unknown as SandboxControlRpc;
}
