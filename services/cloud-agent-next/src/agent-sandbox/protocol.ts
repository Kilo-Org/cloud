import type { WrapperClient } from '../kilo/wrapper-client.js';
import type { TerminalWrapperClient } from '../terminal/access.js';
import type {
  FencedLegacyExecutionRequest,
  FencedWrapperDispatchRequest,
  WorkspaceReady,
} from '../execution/types.js';

export type SandboxDeleteReason = 'explicit' | 'retention-expired' | 'recovery';

export type WrapperInstanceLease = {
  instanceId: string;
  instanceGeneration: number;
};

export type ObservedWrapper = {
  representation: 'process' | 'container';
  id: string;
  port?: number;
  instanceId?: string;
  instanceGeneration?: number;
};

export type WrapperObservation =
  | { status: 'absent' }
  | { status: 'present'; observed: ObservedWrapper[] }
  | { status: 'inspection-failed'; error: string };

export type WrapperStopTarget =
  | { kind: 'instance'; instance: WrapperInstanceLease }
  | { kind: 'session' };

export type WrapperStopReason =
  | 'readiness-failed'
  | 'startup-failed'
  | 'unhealthy-wrapper'
  | 'terminal-failed'
  | 'terminal-interrupted'
  | 'idle-timeout'
  | 'keep-warm-expired'
  | 'user-interrupt'
  | 'session-delete'
  | 'unexpected-wrapper'
  | 'observation-failed';

export type StopWrappersResult =
  | { status: 'absent'; stoppedInstanceIds?: string[] }
  | { status: 'still-present'; observed: ObservedWrapper[]; error?: string }
  | { status: 'inspection-failed'; error: string };

export type TerminalClientResult =
  | { status: 'ready'; client: TerminalWrapperClient }
  | { status: 'not-running' }
  | { status: 'unhealthy' };

export type WrapperLogs = {
  files: Record<string, string>;
  processes?: Array<{ pid: number; command: string; status: string }>;
};

export type EnsureWrapperRequest = {
  plan: FencedWrapperDispatchRequest | FencedLegacyExecutionRequest;
  leasedInstance?: WrapperInstanceLease;
  prepared: {
    ready: WorkspaceReady;
    context: { workspacePath: string };
  };
  onProgress?: (step: string, message: string) => void;
};

export type EnsuredWrapper =
  | {
      status: 'wrapper-running';
      client: WrapperClient;
    }
  | {
      status: 'session-ready';
      client: WrapperClient;
      ready: WorkspaceReady;
      kiloSessionId: string;
    };

/**
 * Product-specific runtime seam for one Cloud Agent session.
 * Provider process, filesystem, and raw sandbox APIs remain private to adapters.
 */
export type AgentSandbox = {
  ensureWrapper(request: EnsureWrapperRequest): Promise<EnsuredWrapper>;
  discoverSessionWrappers(): Promise<WrapperObservation>;
  stopWrappers(request: {
    target: WrapperStopTarget;
    attemptId: string;
    reason: WrapperStopReason;
  }): Promise<StopWrappersResult>;
  probeHealth(): Promise<void>;
  getRunningWrapper(): Promise<WrapperClient | null>;
  getRunningTerminalClient(): Promise<TerminalClientResult>;
  readWrapperLogs(): Promise<WrapperLogs | null>;
  keepAlive(): Promise<void>;
  delete(reason: SandboxDeleteReason): Promise<void>;
};
