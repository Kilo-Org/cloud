import type { CloudAgentEnvironmentSetupRun } from '@kilocode/db/schema';
import type {
  EnvironmentSetupNetworkRequest,
  EnvironmentSetupPendingVerification,
  EnvironmentSetupPreviousConfiguration,
  EnvironmentSetupPullRequest,
  EnvironmentSetupRunStatus,
  EnvironmentSetupSecretRequest,
  EnvironmentSetupVerification,
  EnvironmentResponse,
} from '@kilocode/cloud-agent-profile';
import { environmentRepositoriesSchema } from '@kilocode/cloud-agent-profile';
import { buildSetupRunDiff, type SetupRunConfigView, type SetupRunDiff } from './diff';

export type SetupRunAgentState =
  | { kind: 'working' }
  | { kind: 'stopped'; reason: string }
  | { kind: 'idle' }
  | { kind: 'unknown' };

export type SetupRunResponse = {
  id: string;
  status: EnvironmentSetupRunStatus;
  statusReason: string | null;
  statusDetail: string | null;
  summary: string | null;
  requirements: string;
  model: string;
  variant: string | null;
  cloudAgentSessionId: string | null;
  kiloSessionId: string | null;
  draftEnvironmentId: string | null;
  targetEnvironmentId: string | null;
  publishedEnvironmentId: string | null;
  environmentName: string | null;
  publishedRevision: number | null;
  secretRequests: EnvironmentSetupSecretRequest[];
  networkRequests: EnvironmentSetupNetworkRequest[];
  generatedSecretKeys: string[];
  setupPullRequest: EnvironmentSetupPullRequest | null;
  pendingVerification: EnvironmentSetupPendingVerification | null;
  lastVerification: EnvironmentSetupVerification | null;
  verificationCount: number;
  verificationLimit: number;
  canRevert: boolean;
  diff: SetupRunDiff | null;
  agentState: SetupRunAgentState | null;
  createdAt: string;
  updatedAt: string;
};

function repositoriesOf(environment: EnvironmentResponse): string[] {
  if (environment.repositories) {
    return environment.repositories.map(repository => repository.repoFullName);
  }
  return environment.repoFullName ? [environment.repoFullName] : [];
}

function configViewOfEnvironment(environment: EnvironmentResponse): SetupRunConfigView {
  return {
    script: environment.commands[0] ?? '',
    plainVars: Object.fromEntries(
      environment.plainVars.map(variable => [variable.key, variable.value] as const)
    ),
    secretKeys: environment.secretKeys,
    sandboxAllocation: environment.sandboxAllocation,
    egressMode: environment.egressMode,
    egressAllowlist: environment.egressAllowlist ?? [],
    requiredHosts: environment.egressRequiredHosts,
    repositories: repositoriesOf(environment),
  };
}

function configViewOfPreviousConfiguration(
  previous: EnvironmentSetupPreviousConfiguration | null
): SetupRunConfigView | null {
  if (previous === null) {
    return null;
  }

  const plainVars: Record<string, string> = {};
  const secretKeys: string[] = [];
  for (const variable of previous.vars) {
    if (variable.isSecret) {
      secretKeys.push(variable.key);
    } else {
      plainVars[variable.key] = variable.value;
    }
  }

  const repositories = environmentRepositoriesSchema.safeParse(previous.repositories);

  return {
    script: previous.commands[0] ?? '',
    plainVars,
    secretKeys,
    sandboxAllocation: previous.sandboxAllocation,
    egressMode: previous.egressMode,
    egressAllowlist: previous.egressAllowlist ?? [],
    requiredHosts: previous.egressRequiredHosts ?? [],
    repositories: repositories.success
      ? repositories.data.map(repository => repository.repoFullName)
      : [],
  };
}

function buildDiff(
  run: CloudAgentEnvironmentSetupRun,
  draft: EnvironmentResponse | null,
  target: EnvironmentResponse | null
): SetupRunDiff | null {
  if (run.status === 'published') {
    const published = draft ?? target;
    if (published === null) {
      return null;
    }
    const before =
      run.target_environment_id === null
        ? null
        : configViewOfPreviousConfiguration(run.previous_configuration);
    return buildSetupRunDiff(before, configViewOfEnvironment(published));
  }

  if (draft === null) {
    return null;
  }
  return buildSetupRunDiff(
    target === null ? null : configViewOfEnvironment(target),
    configViewOfEnvironment(draft)
  );
}

function canRevert(run: CloudAgentEnvironmentSetupRun): boolean {
  return (
    run.status === 'published' &&
    (run.previous_configuration !== null || run.target_environment_id === null)
  );
}

export function toSetupRunResponse(
  run: CloudAgentEnvironmentSetupRun,
  draft: EnvironmentResponse | null,
  target: EnvironmentResponse | null,
  agentState: SetupRunAgentState | null
): SetupRunResponse {
  return {
    id: run.id,
    status: run.status,
    statusReason: run.status_reason,
    statusDetail: run.status_detail,
    summary: run.summary,
    requirements: run.requirements,
    model: run.model,
    variant: run.variant,
    cloudAgentSessionId: run.cloud_agent_session_id,
    kiloSessionId: run.kilo_session_id,
    draftEnvironmentId: run.draft_environment_id,
    targetEnvironmentId: run.target_environment_id,
    publishedEnvironmentId: run.published_environment_id,
    environmentName: (draft ?? target)?.name ?? null,
    publishedRevision: run.published_revision,
    secretRequests: run.secret_requests,
    networkRequests: run.network_requests,
    generatedSecretKeys: run.generated_secret_keys,
    setupPullRequest: run.setup_pull_request,
    pendingVerification: run.pending_verification,
    lastVerification: run.last_verification,
    verificationCount: run.verification_count,
    verificationLimit: run.verification_limit,
    canRevert: canRevert(run),
    diff: buildDiff(run, draft, target),
    agentState,
    createdAt: new Date(run.created_at).toISOString(),
    updatedAt: new Date(run.updated_at).toISOString(),
  };
}
