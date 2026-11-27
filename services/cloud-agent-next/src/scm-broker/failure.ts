type ScmPlatform = 'github' | 'gitlab' | 'bitbucket';
export type ScmFailureKind = 'denied' | 'transient';

// Only known access refusals prove denial. Service, configuration and unknown
// failures remain retryable within the caller's existing deadline.
const DENIED: Record<ScmPlatform, ReadonlySet<string>> = {
  github: new Set([
    'invalid_repo_format',
    'no_installation_found',
    'repository_not_installed',
    'integration_mismatch',
    'invalid_org_id',
  ]),
  gitlab: new Set([
    'no_integration_found',
    'invalid_org_id',
    'no_token',
    'token_expired_no_refresh',
    'repository_url_required',
    'invalid_repository_url',
    'no_matching_integration',
    'ambiguous_integration',
    'no_project_token',
    'invalid_instance_url',
  ]),
  bitbucket: new Set([
    'not_connected',
    'reconnect_required',
    'insufficient_permissions',
    'integration_mismatch',
    'workspace_mismatch',
    'repository_not_found',
    'repository_mismatch',
  ]),
};

export function scmFailureKind(platform: ScmPlatform, reason: string): ScmFailureKind {
  return DENIED[platform].has(reason) ? 'denied' : 'transient';
}

/** Preserve broker refusal semantics without carrying credentials or raw responses. */
export class ScmCapabilityIssueError extends Error {
  readonly kind: ScmFailureKind;

  constructor(platform: ScmPlatform, reason: string) {
    const kind = scmFailureKind(platform, reason);
    super(
      kind === 'denied' ? 'Repository access is denied' : 'SCM capability issuance is unavailable'
    );
    this.name = 'ScmCapabilityIssueError';
    this.kind = kind;
  }
}
