import {
  CONTROL_DIAGNOSTIC_STRING_CHARSET,
  CONTROL_DIAGNOSTIC_STRING_MAX_LENGTH,
} from './diagnostics.js';

/**
 * The private context for one cold credential-grant attempt. It carries the
 * deciding phase and an allowlisted reason, plus the closed provider,
 * containment, repository-kind and token-class facts the deciding branch already
 * holds, from the helper that rejects to the single `route_failed` event. It is
 * one writer per attempt, write-once, and detached on `snapshot`.
 */

export const GRANT_PHASES = [
  'configuration',
  'validation',
  'broker_authorization',
  'broker_issuance',
  'compatibility',
  'timeout',
  'unknown',
] as const;
export type GrantPhase = (typeof GRANT_PHASES)[number];

/** Operator-setting outcomes, separate from validation and broker checks. */
export const GRANT_CONFIGURATION_REASONS = [
  'namespace_unbound',
  'runtime_proxy_targets_unavailable',
  'invalid_target',
  'outbound_container_unavailable',
] as const;

/** Local credential checks that already reject the attempt. */
export const GRANT_VALIDATION_REASONS = [
  'invalid_timestamp',
  'invalid_sandbox_id',
  'invalid_member',
  'invalid_token',
  'invalid_directory',
  'invalid_scope_id',
  'github_repo_shape',
  'explicit_repository_token',
  'vercel_contained_repository',
  'unmanaged_gitlab_token',
  'bitbucket_repository',
  'repository_url',
  'capability_shape',
  'gitlab_capability_mismatch',
  'missing_native_token',
  'invalid_grant',
  'direct_token_rejected',
] as const;

/** Scope-compatibility checks that already reject the attempt. */
export const GRANT_COMPATIBILITY_REASONS = [
  'scope_member_limit',
  'mixed_credential_class',
  'scope_handle_conflict',
  'scope_mismatch',
  'existing_grant_mismatch',
  'member_identity_mismatch',
  'backing_authorization_mismatch',
] as const;

/** GitHub authorization reasons the authorization schema already returned. */
const GITHUB_AUTHORIZATION_REASONS = [
  'database_not_configured',
  'invalid_repo_format',
  'no_installation_found',
  'repository_not_installed',
  'integration_mismatch',
  'invalid_org_id',
] as const;

/** The client extras already declared on the resolve/issue results. */
const CLIENT_BROKER_REASONS = [
  'capability_configuration_error',
  'invalid_targets',
  'invalid_capability',
  'expired_capability',
  'service_not_configured',
  'rpc_error',
] as const;

const BITBUCKET_BROKER_REASONS = [
  'invalid_request',
  'not_connected',
  'reconnect_required',
  'temporarily_unavailable',
  'insufficient_permissions',
  'integration_mismatch',
  'workspace_mismatch',
  'repository_not_found',
  'repository_mismatch',
  'service_not_configured',
  'rpc_error',
  'capability_configuration_error',
] as const;

const GITLAB_BROKER_REASONS = [
  'database_not_configured',
  'no_integration_found',
  'invalid_org_id',
  'no_token',
  'token_refresh_failed',
  'token_expired_no_refresh',
  'repository_url_required',
  'invalid_repository_url',
  'no_matching_integration',
  'ambiguous_integration',
  'project_lookup_failed',
  'no_project_token',
  'invalid_instance_url',
  'invalid_gitlab_url',
  'unsupported_gitlab_instance',
  'integration_identity_missing',
  'capability_configuration_error',
  'service_not_configured',
  'rpc_error',
] as const;

/** Every reason string the broker client can already have returned. */
export const GRANT_BROKER_REASONS = [
  ...GITHUB_AUTHORIZATION_REASONS,
  ...CLIENT_BROKER_REASONS,
  ...BITBUCKET_BROKER_REASONS,
  ...GITLAB_BROKER_REASONS,
] as const;

/** A broker reason that names an operator-setting outcome, not a broker call. */
export const GRANT_CONFIGURATION_OVERRIDE_REASONS = [
  'service_not_configured',
  'database_not_configured',
  'capability_configuration_error',
] as const;

export const GRANT_FAILURE_REASONS = [
  ...GRANT_CONFIGURATION_REASONS,
  ...GRANT_VALIDATION_REASONS,
  ...GRANT_COMPATIBILITY_REASONS,
  ...GRANT_BROKER_REASONS,
  'issuance_timeout',
  'unknown',
] as const;
export type GrantFailureReason = (typeof GRANT_FAILURE_REASONS)[number];

export const GRANT_PROVIDERS = ['cloudflare', 'vercel', 'cloudflare-containers'] as const;
export type GrantProvider = (typeof GRANT_PROVIDERS)[number];
export const GRANT_CONTAINMENT = ['enabled', 'disabled'] as const;
export type GrantContainment = (typeof GRANT_CONTAINMENT)[number];
export const GRANT_REPOSITORY_KINDS = ['github', 'gitlab', 'bitbucket', 'git'] as const;
export type GrantRepositoryKind = (typeof GRANT_REPOSITORY_KINDS)[number];
export const GRANT_TOKEN_CLASSES = ['legacy', 'runtime_authorized'] as const;
export type GrantTokenClass = (typeof GRANT_TOKEN_CLASSES)[number];

const PHASE_SET: ReadonlySet<string> = new Set<string>(GRANT_PHASES);
const REASON_SET: ReadonlySet<string> = new Set<string>(GRANT_FAILURE_REASONS);
const BROKER_SET: ReadonlySet<string> = new Set<string>(GRANT_BROKER_REASONS);
const CONFIGURATION_OVERRIDE_SET: ReadonlySet<string> = new Set<string>(
  GRANT_CONFIGURATION_OVERRIDE_REASONS
);
const PROVIDER_SET: ReadonlySet<string> = new Set<string>(GRANT_PROVIDERS);
const CONTAINMENT_SET: ReadonlySet<string> = new Set<string>(GRANT_CONTAINMENT);
const REPOSITORY_KIND_SET: ReadonlySet<string> = new Set<string>(GRANT_REPOSITORY_KINDS);
const TOKEN_CLASS_SET: ReadonlySet<string> = new Set<string>(GRANT_TOKEN_CLASSES);

/** The closed optional facts a deciding branch may already hold. */
export type GrantDiagnosticFacts = {
  provider?: GrantProvider;
  containment?: GrantContainment;
  repositoryKind?: GrantRepositoryKind;
  tokenClass?: GrantTokenClass;
};

/** The one decision a cold attempt records. */
export type GrantDiagnosticDecision = {
  grantPhase: GrantPhase;
  grantFailureReason: GrantFailureReason;
};

export type GrantDiagnosticSnapshot = GrantDiagnosticDecision & GrantDiagnosticFacts;

export type GrantDiagnostic = {
  /** Adds closed facts as the owning attempt learns them; ignored after a timeout. */
  fact: (fields: GrantDiagnosticFacts) => void;
  /** Write-once. Later calls, including after a timeout, are dropped. */
  record: (decision: GrantDiagnosticDecision) => void;
  /** Seals writes; a closure so `withTimeout` can call it without a receiver. */
  markTimeout: () => void;
  /** A detached plain object; never the live context. */
  snapshot: () => GrantDiagnosticSnapshot;
};

function isClosedValue(value: unknown, allowed: ReadonlySet<string>): value is string {
  return (
    typeof value === 'string' &&
    value.length <= CONTROL_DIAGNOSTIC_STRING_MAX_LENGTH &&
    CONTROL_DIAGNOSTIC_STRING_CHARSET.test(value) &&
    allowed.has(value)
  );
}

/**
 * One owner for the broker allowlist. It reads the reason string the client
 * already returned; it never re-parses an RPC body. A reason outside the
 * allowlist keeps the call's phase and becomes `unknown`.
 */
export function brokerGrantFailure(
  kind: 'broker_authorization' | 'broker_issuance',
  reason: string
): GrantDiagnosticDecision {
  if (!BROKER_SET.has(reason)) return { grantPhase: kind, grantFailureReason: 'unknown' };
  if (CONFIGURATION_OVERRIDE_SET.has(reason)) {
    return { grantPhase: 'configuration', grantFailureReason: reason as GrantFailureReason };
  }
  return { grantPhase: kind, grantFailureReason: reason as GrantFailureReason };
}

export function createGrantDiagnostic(): GrantDiagnostic {
  const facts: GrantDiagnosticFacts = {};
  let decision: GrantDiagnosticDecision | undefined;
  let timedOut = false;
  const fact = (fields: GrantDiagnosticFacts): void => {
    if (timedOut) return;
    if (fields.provider !== undefined && isClosedValue(fields.provider, PROVIDER_SET)) {
      facts.provider = fields.provider;
    }
    if (fields.containment !== undefined && isClosedValue(fields.containment, CONTAINMENT_SET)) {
      facts.containment = fields.containment;
    }
    if (
      fields.repositoryKind !== undefined &&
      isClosedValue(fields.repositoryKind, REPOSITORY_KIND_SET)
    ) {
      facts.repositoryKind = fields.repositoryKind;
    }
    if (fields.tokenClass !== undefined && isClosedValue(fields.tokenClass, TOKEN_CLASS_SET)) {
      facts.tokenClass = fields.tokenClass;
    }
  };
  const record = (next: GrantDiagnosticDecision): void => {
    if (decision !== undefined || timedOut) return;
    decision = next;
  };
  const markTimeout = (): void => {
    timedOut = true;
  };
  const snapshot = (): GrantDiagnosticSnapshot => {
    const copied = pickFacts(facts);
    if (timedOut) {
      return { ...copied, grantPhase: 'timeout', grantFailureReason: 'issuance_timeout' };
    }
    if (decision === undefined) {
      return { ...copied, grantPhase: 'unknown', grantFailureReason: 'unknown' };
    }
    return { ...copied, ...decision };
  };
  return { fact, record, markTimeout, snapshot };
}

function pickFacts(facts: GrantDiagnosticFacts): GrantDiagnosticFacts {
  const copied: GrantDiagnosticFacts = {};
  if (facts.provider !== undefined && isClosedValue(facts.provider, PROVIDER_SET)) {
    copied.provider = facts.provider;
  }
  if (facts.containment !== undefined && isClosedValue(facts.containment, CONTAINMENT_SET)) {
    copied.containment = facts.containment;
  }
  if (
    facts.repositoryKind !== undefined &&
    isClosedValue(facts.repositoryKind, REPOSITORY_KIND_SET)
  ) {
    copied.repositoryKind = facts.repositoryKind;
  }
  if (facts.tokenClass !== undefined && isClosedValue(facts.tokenClass, TOKEN_CLASS_SET)) {
    copied.tokenClass = facts.tokenClass;
  }
  return copied;
}

export type GrantDiagnosticLogFields = {
  grantPhase?: string;
  grantFailureReason?: string;
  provider?: string;
  containment?: string;
  repositoryKind?: string;
  tokenClass?: string;
};

/**
 * The one picker `failRoute` copies through. It allows only the six grant field
 * names; a value outside the closed set is dropped, not copied.
 */
export function pickGrantDiagnosticFields(
  snapshot: GrantDiagnosticSnapshot
): GrantDiagnosticLogFields {
  const fields: GrantDiagnosticLogFields = {};
  if (isClosedValue(snapshot.grantPhase, PHASE_SET)) fields.grantPhase = snapshot.grantPhase;
  if (isClosedValue(snapshot.grantFailureReason, REASON_SET)) {
    fields.grantFailureReason = snapshot.grantFailureReason;
  }
  if (isClosedValue(snapshot.provider, PROVIDER_SET)) fields.provider = snapshot.provider;
  if (isClosedValue(snapshot.containment, CONTAINMENT_SET))
    fields.containment = snapshot.containment;
  if (isClosedValue(snapshot.repositoryKind, REPOSITORY_KIND_SET)) {
    fields.repositoryKind = snapshot.repositoryKind;
  }
  if (isClosedValue(snapshot.tokenClass, TOKEN_CLASS_SET)) fields.tokenClass = snapshot.tokenClass;
  return fields;
}
