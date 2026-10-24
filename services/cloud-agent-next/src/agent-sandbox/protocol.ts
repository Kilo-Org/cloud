export type SandboxDeleteReason = 'explicit' | 'retention-expired' | 'recovery' | 'late-create';

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
  | 'billing_blocked'
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
