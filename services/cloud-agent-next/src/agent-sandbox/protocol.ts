import type { WrapperClient } from '../kilo/wrapper-client.js';
import type { TerminalWrapperClient } from '../terminal/access.js';
import type { WrapperSessionReadyRequest } from '../shared/wrapper-bootstrap.js';
import type {
  FencedLegacyExecutionRequest,
  FencedWrapperDispatchRequest,
  WorkspaceReady,
} from '../execution/types.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';

export type SandboxDeleteReason = 'explicit' | 'retention-expired' | 'recovery';

export type SessionDeletionIntent = {
  reason: Extract<SandboxDeleteReason, 'explicit' | 'retention-expired'>;
  startedAt: number;
};

export type AgentSandboxFailure =
  | 'provider_not_configured'
  | 'provider_auth_failed'
  | 'runtime_not_running'
  | 'runtime_creation_failed'
  | 'runtime_configuration_drift'
  | 'runtime_deleted_during_active_work'
  | 'runtime_max_duration_reached'
  | 'runtime_infrastructure_failed'
  | 'capability_unavailable';

export class AgentSandboxUnavailableError extends Error {
  constructor(
    message: string,
    public readonly failure: AgentSandboxFailure = 'capability_unavailable'
  ) {
    super(message);
    this.name = 'AgentSandboxUnavailableError';
  }
}

export const WRAPPER_DISCOVERY_LIST_PROCESSES_TIMEOUT_REASON =
  'wrapper_discovery_list_processes_timeout';
export type WrapperInspectionFailureReason = typeof WRAPPER_DISCOVERY_LIST_PROCESSES_TIMEOUT_REASON;

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
  | {
      status: 'inspection-failed';
      error: string;
      reason?: WrapperInspectionFailureReason;
    };

export type WrapperStopTarget =
  | { kind: 'instance'; instance: WrapperInstanceLease }
  | { kind: 'session' };

export type WrapperStopReason =
  | 'readiness-failed'
  | 'startup-failed'
  | 'unhealthy-wrapper'
  | 'terminal-failed'
  | 'terminal-completed'
  | 'terminal-ended'
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
  | {
      status: 'inspection-failed';
      error: string;
      reason?: WrapperInspectionFailureReason;
    };

export type TerminalClientResult =
  | { status: 'ready'; client: TerminalWrapperClient }
  | { status: 'not-running' }
  | { status: 'unhealthy' }
  | { status: 'capability-unavailable'; message: string };

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
    readyRequest?: WrapperSessionReadyRequest;
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

export type ProviderDeletionPlan =
  | { kind: 'not-applicable' }
  | { kind: 'complete' }
  | { kind: 'deferred'; entries: Record<string, unknown> };

/**
 * Session-DO capabilities a provider lifecycle needs: durable storage for its
 * intents/tombstones, alarm scheduling for retries, and terminal-state
 * transitions owned by the session.
 */
export type AgentSandboxLifecycleHost = {
  storage: DurableObjectStorage;
  scheduleAlarmAtOrBefore(deadline: number): Promise<void>;
  eraseDurableObjectState(): Promise<void>;
  purgeDeletedSessionPayload(): Promise<void>;
  getSessionIdForLogs(): string | undefined;
};

/**
 * Provider-side lifecycle reconciliation for one Cloud Agent session:
 * settling interrupted runtime creation and driving deletion to a terminal
 * state. Methods self-guard on stored provider state, so the session can
 * invoke them on alarm paths without knowing its provider.
 *
 * `planDeletion` only returns what to persist; the session commits the
 * returned entries atomically with its own deletion-intent fence.
 */
export type AgentSandboxLifecycle = {
  reconcileCreateIntent(now: number): Promise<void>;
  planDeletion(input: {
    metadata: SessionMetadata;
    intent: SessionDeletionIntent;
    now: number;
  }): Promise<ProviderDeletionPlan>;
  reconcilePendingDeletion(now: number): Promise<'handled' | 'none'>;
};
