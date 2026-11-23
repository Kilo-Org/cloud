import type {
  EnvironmentSetupRunData,
  EnvironmentSetupNetworkRequest,
  EnvironmentSetupRunStatus,
  EnvironmentSetupSecretRequest,
} from '@kilocode/db/schema';
import type { EgressMode } from '@kilocode/worker-utils/egress-allowlist';

export type {
  EnvironmentSetupCheck,
  EnvironmentSetupNetworkRequest,
  EnvironmentSetupPendingVerification,
  EnvironmentSetupPreviousConfiguration,
  EnvironmentSetupRunStatus,
  EnvironmentSetupSecretRequest,
  EnvironmentSetupTargetSettings,
  EnvironmentSetupVerification,
} from '@kilocode/db/schema';

export const ENVIRONMENT_SETUP_LIMITS = {
  MAX_REQUIREMENTS_LENGTH: 8000,
  MAX_SECRET_KEYS_PER_REQUEST: 10,
  MAX_SECRET_REQUESTS_PER_RUN: 20,
  MAX_NETWORK_HOSTS_PER_REQUEST: 20,
  MAX_NETWORK_REQUESTS_PER_RUN: 50,
  MAX_REQUIRED_HOSTS: 50,
  MAX_EFFECTIVE_ALLOWLIST: 100,
  DEFAULT_VERIFICATION_LIMIT: 6,
  MAX_CHECKS: 10,
  MAX_SUMMARY_LENGTH: 5000,
} as const;

export const OPEN_SETUP_RUN_STATUSES = [
  'starting',
  'running',
  'needs_input',
  'verifying',
  'publish_conflict',
  'failed',
] as const;

export const AGENT_WRITABLE_SETUP_RUN_STATUSES = ['running', 'needs_input', 'verifying'] as const;

export const ENVIRONMENT_SETUP_STATUS_REASONS = [
  'session_start_failed',
  'agent_failed',
  'verification_limit_reached',
  'publish_validation_failed',
  'draft_deleted',
  'abandoned',
] as const;

export const HIGH_PRIVILEGE_SECRET_PATTERNS: readonly RegExp[] = [
  /^AWS_SECRET_ACCESS_KEY$/,
  /^AWS_SESSION_TOKEN$/,
  /^GOOGLE_APPLICATION_CREDENTIALS$/,
  /^AZURE_CLIENT_SECRET$/,
  /^GITHUB_TOKEN$/,
  /^GH_TOKEN$/,
  /^GITLAB_TOKEN$/,
  /ADMIN/,
  /PROD/,
  /ROOT/,
  /SERVICE_ROLE/,
  /MASTER/,
];

export function isHighPrivilegeSecretKey(key: string): boolean {
  return HIGH_PRIVILEGE_SECRET_PATTERNS.some(pattern => pattern.test(key.toUpperCase()));
}

const OPEN_SETUP_RUN_STATUS_SET: ReadonlySet<EnvironmentSetupRunStatus> = new Set(
  OPEN_SETUP_RUN_STATUSES
);

const AGENT_WRITABLE_SETUP_RUN_STATUS_SET: ReadonlySet<EnvironmentSetupRunStatus> = new Set(
  AGENT_WRITABLE_SETUP_RUN_STATUSES
);

export function isResumableSetupRunStatus(status: EnvironmentSetupRunStatus): boolean {
  return status === 'running' || status === 'failed';
}

export function isOpenSetupRunStatus(status: EnvironmentSetupRunStatus): boolean {
  return OPEN_SETUP_RUN_STATUS_SET.has(status);
}

export function isAgentWritableSetupRunStatus(status: EnvironmentSetupRunStatus): boolean {
  return AGENT_WRITABLE_SETUP_RUN_STATUS_SET.has(status);
}

type SetupRunRequests = {
  secret_requests: readonly EnvironmentSetupSecretRequest[];
  network_requests: readonly EnvironmentSetupNetworkRequest[];
};

export function pendingRequestCount(run: SetupRunRequests): number {
  const pendingSecrets = run.secret_requests.filter(request => request.state === 'pending').length;
  const pendingHosts = run.network_requests.filter(request => request.state === 'pending').length;
  return pendingSecrets + pendingHosts;
}

export function isRestrictedEgress(egressMode: EgressMode | null | undefined): boolean {
  return egressMode === 'allowlist';
}

/**
 * The effective allowlist: the user's allowed hosts, then the hosts the setup
 * agent found. Both are lowercased and de-duplicated; the first occurrence wins.
 * An absent allowlist stays absent, which keeps the legacy unrestricted mode.
 */
export function mergeRequiredHosts(
  allowlist: string[] | undefined,
  required: string[] | null | undefined
): string[] | undefined {
  if (allowlist === undefined) return undefined;
  const merged: string[] = [];
  for (const host of [...allowlist, ...(required ?? [])]) {
    const lowered = host.toLowerCase();
    if (!merged.includes(lowered)) merged.push(lowered);
  }
  return merged;
}

/**
 * The hosts a restricted session may reach: the allowed hosts followed by the
 * required hosts, lowercased and de-duplicated. An unrestricted policy has no
 * effective allowlist.
 */
export function effectiveEgressAllowlist(
  egressMode: EgressMode | null,
  allowlist: readonly string[] | null,
  requiredHosts: readonly string[] | null
): string[] | null {
  if (egressMode !== 'allowlist') return null;
  return mergeRequiredHosts([...(allowlist ?? [])], [...(requiredHosts ?? [])]) ?? [];
}

function sameHostList(left: readonly string[] | null, right: readonly string[] | null): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return left.length === right.length && left.every((host, index) => host === right[index]);
}

export function hasDuplicateCheckNames(checks: readonly { name: string }[]): boolean {
  return new Set(checks.map(check => check.name)).size !== checks.length;
}

export type EnvironmentSetupCompletionGateInput = {
  draftRevision: number;
  draftSandboxAllocation: string | null;
  draftEgressMode: EgressMode | null;
  draftEgressAllowlist: string[] | null;
  draftEgressRequiredHosts: string[] | null;
  run: Pick<EnvironmentSetupRunData, 'last_verification' | 'secret_requests' | 'network_requests'>;
};

export type EnvironmentSetupCompletionGateResult = { ok: true } | { ok: false; reason: string };

/**
 * The server-side check that must pass before a draft is published. The first
 * failure returns the message the agent has to act on.
 */
export function evaluateCompletionGate(
  input: EnvironmentSetupCompletionGateInput
): EnvironmentSetupCompletionGateResult {
  const {
    draftRevision,
    draftSandboxAllocation,
    draftEgressMode,
    draftEgressAllowlist,
    draftEgressRequiredHosts,
    run,
  } = input;
  const verification = run.last_verification;
  if (!verification) {
    return { ok: false, reason: 'No verification has run. Call verify_environment_draft.' };
  }

  if (verification.configurationRevision !== draftRevision) {
    return {
      ok: false,
      reason: `The last verification ran revision ${verification.configurationRevision}, but the draft is at revision ${draftRevision}. Verify again.`,
    };
  }

  if (verification.checks.length === 0) {
    return { ok: false, reason: 'The verification ran no checks. Verify again.' };
  }

  if (hasDuplicateCheckNames(verification.checks)) {
    return { ok: false, reason: 'Verification check names must be unique. Verify again.' };
  }
  if (hasDuplicateCheckNames(verification.results)) {
    return {
      ok: false,
      reason: 'Verification result names must be unique. Record the results again.',
    };
  }

  if (verification.preparation !== 'completed') {
    return {
      ok: false,
      reason: `Setup failed in the last verification: ${verification.preparationError ?? 'no error reported'}.`,
    };
  }

  if (
    verification.sandboxAllocation !== undefined &&
    verification.sandboxAllocation !== draftSandboxAllocation
  ) {
    return {
      ok: false,
      reason: 'The sandbox allocation changed after verification. Verify again.',
    };
  }

  for (const check of verification.checks) {
    const result = verification.results.find(candidate => candidate.name === check.name);
    if (!result?.passed) {
      return { ok: false, reason: `Check "${check.name}" did not pass.` };
    }
  }

  const pending = pendingRequestCount(run);
  if (pending !== 0) {
    return { ok: false, reason: `${pending} requests are still pending for the user.` };
  }

  const verifiedEgressMode = verification.egressMode ?? 'unrestricted';
  const sessionEgressMode = draftEgressMode === 'allowlist' ? 'allowlist' : 'unrestricted';
  if (verifiedEgressMode !== sessionEgressMode) {
    return {
      ok: false,
      reason:
        'The verification ran with a different network mode than sessions will use. Verify again.',
    };
  }

  if (verification.egressAllowlist !== undefined) {
    const verifiedAllowlist = effectiveEgressAllowlist(
      verifiedEgressMode,
      verification.egressAllowlist,
      null
    );
    const currentAllowlist = effectiveEgressAllowlist(
      draftEgressMode,
      draftEgressAllowlist,
      draftEgressRequiredHosts
    );
    if (!sameHostList(verifiedAllowlist, currentAllowlist)) {
      return {
        ok: false,
        reason: 'The allowed network hosts changed after verification. Verify again.',
      };
    }
  }

  return { ok: true };
}
