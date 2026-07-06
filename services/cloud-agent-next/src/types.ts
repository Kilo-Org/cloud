import type { getSandbox, ExecutionSession, Sandbox } from '@cloudflare/sandbox';
import type { CloudAgentSession } from './persistence/CloudAgentSession.js';
import type { CloudAgentQueueReport } from '@kilocode/worker-utils/cloud-agent-queue-report';
import type { AccessibleCloudAgentSession } from '@kilocode/worker-utils/cloud-agent-session-access';
import type { UserKiloFacade } from './kilo-facade/user-kilo-facade.js';
import type { CallbackJob } from './callbacks/index.js';
import type { NotificationsBinding } from './notifications-binding.js';
import type { SessionIngestBinding } from './session-ingest-binding.js';
import type { SecretBinding } from './auth.js';
import * as z from 'zod';
import { Limits } from './schema.js';
import { SESSION_ID_RE } from './shared/protocol.js';
import { PNPM_STORE_ENV_VAR } from './shared/runtime-environment.js';

export const sessionIdSchema = z.string().regex(SESSION_ID_RE, 'Invalid session ID format');

export const githubRepoSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Invalid repository format');

export const gitUrlSchema = z
  .string()
  .url()
  .refine(url => url.startsWith('https://'), 'Only HTTPS URLs are supported');

export type CanonicalBitbucketRepository = {
  workspaceSlug: string;
  repositorySlug: string;
};

function canonicalBitbucketPathSegment(value: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  return /^[A-Za-z0-9_.-]+$/.test(decoded) && decoded !== '.' && decoded !== '..' ? decoded : null;
}

function parseBitbucketCloudCloneUrl(
  repositoryUrl: string,
  allowSsh: boolean
): CanonicalBitbucketRepository | null {
  let url: URL;
  try {
    url = new URL(repositoryUrl);
  } catch {
    return null;
  }

  if (url.hostname !== 'bitbucket.org' || url.port || url.search || url.hash) return null;
  if (url.protocol === 'https:') {
    if (url.username || url.password) return null;
  } else if (allowSsh && url.protocol === 'ssh:') {
    if (url.username !== 'git' || url.password) return null;
  } else {
    return null;
  }

  const pathSegments = url.pathname.split('/');
  if (pathSegments.length !== 3 || pathSegments[0] !== '') return null;
  const [workspaceSegment, repositorySegmentWithSuffix] = pathSegments.slice(1);
  if (!repositorySegmentWithSuffix?.endsWith('.git')) return null;

  const workspaceSlug = canonicalBitbucketPathSegment(workspaceSegment ?? '');
  const repositorySlug = canonicalBitbucketPathSegment(
    repositorySegmentWithSuffix.slice(0, -'.git'.length)
  );
  return workspaceSlug && repositorySlug ? { workspaceSlug, repositorySlug } : null;
}

export function parseCanonicalBitbucketCloneUrl(
  repositoryUrl: string
): CanonicalBitbucketRepository | null {
  return parseBitbucketCloudCloneUrl(repositoryUrl, false);
}

export function parseManagedBitbucketCloneUrl(
  repositoryUrl: string
): CanonicalBitbucketRepository | null {
  return parseBitbucketCloudCloneUrl(repositoryUrl, true);
}

export const RESERVED_ENV_VARS = [
  'HOME',
  'SESSION_ID',
  'SESSION_HOME',
  PNPM_STORE_ENV_VAR,
] as const;

export const envVarsSchema = z
  .record(
    z.string().max(Limits.MAX_ENV_VAR_KEY_LENGTH),
    z.string().max(Limits.MAX_ENV_VAR_VALUE_LENGTH)
  )
  .refine(obj => Object.keys(obj).length <= Limits.MAX_ENV_VARS, {
    message: `Maximum ${Limits.MAX_ENV_VARS} environment variables allowed`,
  })
  .refine(
    obj => {
      const keys = Object.keys(obj);
      return !keys.some(key => (RESERVED_ENV_VARS as readonly string[]).includes(key));
    },
    {
      message: `Cannot set reserved environment variables: ${RESERVED_ENV_VARS.join(', ')}. These are managed by the system.`,
    }
  );

export type SandboxInstance = ReturnType<typeof getSandbox>;

/** Cloudflare Session instance for executing commands within a sandbox */
export type { ExecutionSession };

/** Unique identifier for a sandbox (container). Covers hash-based prefixes, per-session IDs, and legacy `__`-delimited formats. */
export type SandboxId =
  | `org-${string}`
  | `usr-${string}`
  | `bot-${string}`
  | `ubt-${string}`
  | `ses-${string}`
  | `crv-${string}`
  | `dind-${string}`
  | `${string}__${string}`
  | `${string}__${string}__${string}`;

/** Unique identifier for a session within a sandbox */
export type SessionId = `agent_${string}`;

export type SessionContext = {
  sandboxId: SandboxId;
  sessionId: SessionId;
  sessionHome: string;
  workspacePath: string;
  branchName: string;
  /** Upstream branch requested by the user (if any) */
  upstreamBranch?: string;
  orgId?: string;
  userId: string;
  botId?: string;
  githubRepo?: string;
  githubToken?: string;
  /** Generic git URL (e.g., GitLab, Bitbucket) */
  gitUrl?: string;
  /** Token for generic git authentication (e.g., GitLab token) */
  gitToken?: string;
  /** Whether the GitLab token was resolved server-side and its remote should be refreshed. */
  gitlabTokenManaged?: boolean;
  /** Whether the Bitbucket token was resolved server-side and its remote should be refreshed. */
  bitbucketTokenManaged?: boolean;
  bitbucketWorkspaceUuid?: string;
  bitbucketRepositoryUuid?: string;
  /** Canonical self-managed GitLab instance URL used to configure glab. */
  gitlabInstanceUrl?: string;
  /** GitLab CLI bearer-mode instruction returned with a server-resolved credential. */
  glabIsOAuth2?: boolean;
  /** Git platform type for correct token/env var handling */
  platform?: 'github' | 'gitlab' | 'bitbucket';
  envVars?: Record<string, string>;
};
/** Result of interrupting a session's running processes */
export type InterruptResult = {
  success: boolean;
  message: string;
  /** Whether matching processes were found by pkill/sandbox API */
  processesFound: boolean;
};

type GetTokenForRepoResult =
  | {
      success: true;
      token: string;
      installationId: string;
      accountLogin: string;
      appType: 'standard' | 'lite';
    }
  | {
      success: false;
      reason:
        | 'database_not_configured'
        | 'invalid_repo_format'
        | 'no_installation_found'
        | 'invalid_org_id';
    };

export type ManagedGitHubFallbackReason =
  | 'no_user_authorization'
  | 'revoked'
  | 'refresh_failed'
  | 'insufficient_user_access'
  | 'lite_installation'
  | 'credential_unreadable'
  | 'credential_configuration_error';

export type GitAuthorConfig = {
  name: string;
  email: string;
};

type ManagedGitHubAuthParams = {
  githubRepo: string;
  userId: string;
  orgId?: string;
  allowUserAuthorization: boolean;
};

type GetCloudAgentAuthForRepoResult =
  | {
      success: true;
      githubToken: string;
      installationId: string;
      accountLogin: string;
      appType: 'standard' | 'lite';
      source: 'user' | 'installation';
      gitAuthor: GitAuthorConfig;
      commitCoAuthor?: GitAuthorConfig;
      fallbackReason?: ManagedGitHubFallbackReason;
    }
  | {
      success: false;
      reason:
        | 'database_not_configured'
        | 'invalid_repo_format'
        | 'no_installation_found'
        | 'repository_not_installed'
        | 'invalid_org_id';
    };

type IssueGitHubSessionCapabilityResult =
  | {
      success: true;
      capability: string;
      installationId: string;
      accountLogin: string;
      appType: 'standard' | 'lite';
      source: 'user' | 'installation';
      gitAuthor: GitAuthorConfig;
      commitCoAuthor?: GitAuthorConfig;
      fallbackReason?: ManagedGitHubFallbackReason;
    }
  | {
      success: false;
      reason:
        | 'database_not_configured'
        | 'invalid_repo_format'
        | 'no_installation_found'
        | 'repository_not_installed'
        | 'invalid_org_id'
        | 'capability_configuration_error';
    };

type RedeemGitHubSessionCapabilityResult =
  | { success: true; authorization: string }
  | {
      success: false;
      reason:
        | 'invalid_capability'
        | 'expired_capability'
        | 'capability_configuration_error'
        | 'container_mismatch'
        | 'invalid_upstream_url'
        | 'upstream_host_not_allowed'
        | 'repository_mismatch'
        | 'invalid_upstream_request'
        | 'source_unavailable'
        | 'identity_mismatch';
    };

type GetGitLabTokenFailureReason =
  | 'database_not_configured'
  | 'no_integration_found'
  | 'invalid_org_id'
  | 'no_token'
  | 'token_refresh_failed'
  | 'token_expired_no_refresh'
  | 'repository_url_required'
  | 'invalid_repository_url'
  | 'no_matching_integration'
  | 'ambiguous_integration'
  | 'project_lookup_failed'
  | 'no_project_token'
  | 'invalid_instance_url';

type GetGitLabTokenResult =
  | { success: true; token: string; instanceUrl: string; glabIsOAuth2: boolean }
  | { success: false; reason: GetGitLabTokenFailureReason };

type GitLabSessionIdentity = {
  accountId: string | null;
  accountLogin: string | null;
};

type GitLabCapabilityCredentialSource =
  | { type: 'integration' }
  | { type: 'project'; projectId: number; tokenDigest: string };

type IssueGitLabSessionCapabilityResult =
  | {
      success: true;
      capability: string;
      instanceOrigin: string;
      instanceHost: string;
      projectPath: string;
      integrationId: string;
      authType: 'oauth' | 'pat';
      identity: GitLabSessionIdentity;
      source: GitLabCapabilityCredentialSource;
      glabIsOAuth2: boolean;
    }
  | {
      success: false;
      reason:
        | GetGitLabTokenFailureReason
        | 'invalid_gitlab_url'
        | 'unsupported_gitlab_instance'
        | 'integration_identity_missing'
        | 'capability_configuration_error';
    };

type RedeemGitLabSessionCapabilityResult =
  | { success: true; headers: { authorization: string; 'PRIVATE-TOKEN'?: never } }
  | { success: true; headers: { authorization?: never; 'PRIVATE-TOKEN': string } }
  | {
      success: false;
      reason:
        | 'invalid_capability'
        | 'expired_capability'
        | 'capability_configuration_error'
        | 'container_mismatch'
        | 'invalid_upstream_url'
        | 'upstream_origin_not_allowed'
        | 'repository_mismatch'
        | 'invalid_upstream_request'
        | 'source_unavailable'
        | 'identity_mismatch';
    };

export type BitbucketTokenFailureReason =
  | 'invalid_request'
  | 'not_connected'
  | 'reconnect_required'
  | 'temporarily_unavailable'
  | 'insufficient_permissions'
  | 'integration_mismatch'
  | 'workspace_mismatch'
  | 'repository_not_found'
  | 'repository_mismatch';

type GetBitbucketTokenResult =
  | { success: true; token: string }
  | { success: false; reason: BitbucketTokenFailureReason };

export type KiloSessionCapabilityTargets = {
  backendBaseUrl: string;
  providerBaseUrl: string;
  sessionIngestBaseUrl: string;
};

export type KiloCapabilityRouteClass =
  | 'provider_model'
  | 'organization_models'
  | 'backend_api'
  | 'session_ingest';

type IssueKiloSessionCapabilityResult =
  | { success: true; capability: string }
  | {
      success: false;
      reason:
        | 'invalid_targets'
        | 'invalid_capability'
        | 'expired_capability'
        | 'capability_configuration_error';
    };

type RedeemKiloSessionCapabilityResult =
  | { success: true; authorization: string; routeClass: KiloCapabilityRouteClass }
  | {
      success: false;
      reason:
        | 'invalid_capability'
        | 'expired_capability'
        | 'capability_configuration_error'
        | 'container_mismatch'
        | 'invalid_upstream_url'
        | 'upstream_not_allowed';
    };

export type GitTokenService = {
  getTokenForRepo(params: {
    githubRepo: string;
    userId: string;
    orgId?: string;
  }): Promise<GetTokenForRepoResult>;
  getToken(installationId: string, appType?: 'standard' | 'lite'): Promise<string>;
  getCloudAgentAuthForRepo?(
    params: ManagedGitHubAuthParams
  ): Promise<GetCloudAgentAuthForRepoResult>;
  issueGitHubSessionCapability(
    params: ManagedGitHubAuthParams & { outboundContainerId: string }
  ): Promise<IssueGitHubSessionCapabilityResult>;
  redeemGitHubSessionCapability(params: {
    capability: string;
    outboundContainerId: string;
    requestMethod: string;
    requestUrl: string;
  }): Promise<RedeemGitHubSessionCapabilityResult>;
  getGitLabToken(params: {
    userId: string;
    orgId?: string;
    repositoryUrl?: string;
    createdOnPlatform?: string;
  }): Promise<GetGitLabTokenResult>;
  getBitbucketToken?(params: {
    userId: string;
    orgId: string;
    expectedIntegrationId?: string;
    workspaceUuid: string;
    repositoryUuid: string;
    repositoryUrl: string;
  }): Promise<GetBitbucketTokenResult>;
  issueGitLabSessionCapability(params: {
    gitUrl: string;
    userId: string;
    outboundContainerId: string;
    orgId?: string;
    createdOnPlatform?: string;
  }): Promise<IssueGitLabSessionCapabilityResult>;
  redeemGitLabSessionCapability(params: {
    capability: string;
    outboundContainerId: string;
    requestMethod: string;
    requestUrl: string;
  }): Promise<RedeemGitLabSessionCapabilityResult>;
  issueKiloSessionCapability(params: {
    userId: string;
    cloudAgentSessionId: string;
    kiloSessionId: string;
    outboundContainerId: string;
    userToken: string;
    targets: KiloSessionCapabilityTargets;
  }): Promise<IssueKiloSessionCapabilityResult>;
  redeemKiloSessionCapability(params: {
    capability: string;
    outboundContainerId: string;
    requestMethod: string;
    requestUrl: string;
    bootstrapKiloSessionId?: string;
  }): Promise<RedeemKiloSessionCapabilityResult>;
};

export type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>;
  /** Durable Object namespace for shared sandbox containers with SCM credential containment */
  SandboxContainment: DurableObjectNamespace<Sandbox>;
  /** Durable Object namespace for per-session sandbox containers (standard-3) */
  SandboxSmall: DurableObjectNamespace<Sandbox>;
  /** Durable Object namespace for per-session sandbox containers with SCM credential containment */
  SandboxSmallContainment: DurableObjectNamespace<Sandbox>;
  /** Durable Object namespace for Docker-in-Docker per-session sandbox containers (standard-3) */
  SandboxDIND: DurableObjectNamespace<Sandbox>;
  /** Durable Object namespace for ephemeral Code Reviewer sandbox containers (standard-3) */
  SandboxCodeReview: DurableObjectNamespace<Sandbox>;
  /** Durable Object namespace for ephemeral Code Reviewer sandbox containers with SCM credential containment */
  SandboxCodeReviewContainment: DurableObjectNamespace<Sandbox>;
  /** Durable Object namespace for CloudAgentSession metadata (SQLite-backed) with RPC support */
  CLOUD_AGENT_SESSION: DurableObjectNamespace<CloudAgentSession>;
  /** Durable Object namespace for per-user Kilo SDK facade coordination */
  USER_KILO_FACADE: DurableObjectNamespace<UserKiloFacade>;
  /** One-way shared sandbox failover overrides keyed by shared identity */
  SHARED_SANDBOX_OVERRIDES: KVNamespace;
  /** Service binding for the session ingest worker */
  SESSION_INGEST: SessionIngestBinding;
  /** Shared secret for internal service-to-service authentication */
  INTERNAL_API_SECRET_PROD: SecretsStoreSecret;
  /** R2 bucket for storing session logs */
  R2_BUCKET: R2Bucket;
  /** R2 bucket used by Cloudflare Sandbox directory backups */
  BACKUP_BUCKET?: R2Bucket;
  /** Queue for callback messages (optional - supports incremental rollout) */
  CALLBACK_QUEUE?: Queue<CallbackJob>;
  /** Dedicated best-effort Cloud Agent reporting queue. */
  CLOUD_AGENT_REPORT_QUEUE: Queue<CloudAgentQueueReport>;
  /** Service binding for centralized git token generation */
  GIT_TOKEN_SERVICE: GitTokenService;
  /** Service binding for dispatching push notifications */
  NOTIFICATIONS: NotificationsBinding;
  /** GitHub Lite App slug for git commit attribution (e.g., 'kiloconnect-lite') */
  GITHUB_LITE_APP_SLUG?: string;
  /** GitHub Lite App bot user ID for git commit email */
  GITHUB_LITE_APP_BOT_USER_ID?: string;
  /** Shared secret for JWT token validation */
  NEXTAUTH_SECRET: SecretBinding;
  /** Comma-separated list of allowed Origins for /stream WebSocket connections */
  WS_ALLOWED_ORIGINS?: string;
  /** Backend base URL (used for balance checks before session spin-up) */
  KILOCODE_BACKEND_BASE_URL?: string;
  /** Base URL override for OpenRouter-compatible Kilo API */
  KILO_OPENROUTER_BASE?: string;
  /** Kilocode CLI timeout override (seconds) */
  CLI_TIMEOUT_SECONDS?: string;
  /** Reaper interval override (ms) */
  REAPER_INTERVAL_MS?: string;
  /** Kilo server idle timeout override (ms) - defaults to 15 minutes */
  KILO_SERVER_IDLE_TIMEOUT_MS?: string;
  /** Shared secret for backend-to-backend authentication (prepareSession/updateSession) */
  INTERNAL_API_SECRET?: string;
  /** Worker base URL for building WebSocket ingest endpoint */
  WORKER_URL?: string;
  /** Sandbox control transport; local dev uses RPC for streaming backup restores */
  SANDBOX_TRANSPORT?: 'http' | 'websocket' | 'rpc';
  /**
   * RSA private key for decrypting encrypted secrets from agent environment profiles.
   * Required when using encryptedSecrets feature. PEM format (base64-encoded).
   */
  AGENT_ENV_VARS_PRIVATE_KEY?: string;
  /** GitHub App slug for git commit attribution (e.g., 'kiloconnect') */
  GITHUB_APP_SLUG?: string;
  /** GitHub App bot user ID for git commit email (e.g., '240665456') */
  GITHUB_APP_BOT_USER_ID?: string;
  /** Comma-separated org IDs that use per-session sandbox containers */
  PER_SESSION_SANDBOX_ORG_IDS?: string;
  /** Comma-separated org IDs that use managed SCM credential containment, or `*` for all orgs */
  MANAGED_SCM_CONTAINMENT_ORG_IDS?: string;
  /** Comma-separated org IDs that receive workspace repo snapshots, or '*' for all */
  REPO_SNAPSHOT_ORG_IDS?: string;
  /**
   * Comma-separated org IDs that get the wrapper-side tool/server memory
   * cgroup partition, or '*' for all. See MEMORY_CGROUPS_PLAN.md (W4).
   */
  TOOL_CGROUP_ORG_IDS?: string;
  /** Passed through to the wrapper when the org is gated in by TOOL_CGROUP_ORG_IDS. See wrapper/src/tool-cgroup.ts. */
  TOOL_CGROUP_MODE?: string;
  TOOL_CGROUP_RESERVE_MB?: string;
  TOOL_CGROUP_SERVER_LIMIT_MB?: string;
  TOOL_CGROUP_SWEEP_INTERVAL_MS?: string;
  TOOL_CGROUP_OOM_GROUP?: string;
  TOOL_CGROUP_CPU_WEIGHT?: string;
  TOOL_CGROUP_SERVER_CPU_WEIGHT?: string;
  /** R2 endpoint for S3-compatible API access (presigned URL generation) */
  R2_ENDPOINT?: string;
  /** R2 read-only access key ID for downloading image attachments */
  R2_ATTACHMENTS_READONLY_ACCESS_KEY_ID?: string;
  /** R2 read-only secret access key for downloading image attachments */
  R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY?: string;
  /** R2 bucket name for image attachments */
  R2_ATTACHMENTS_BUCKET?: string;
  /** R2 bucket name used by Cloudflare Sandbox directory backups */
  BACKUP_BUCKET_NAME?: string;
  /** Cloudflare account ID used for R2 backup presigning */
  CLOUDFLARE_R2_ACCOUNT_ID?: string;
  /** R2 access key ID used for backup uploads */
  R2_ACCESS_KEY_ID?: string;
  /** R2 secret access key used for backup uploads */
  R2_SECRET_ACCESS_KEY?: string;
  /**
   * Hyperdrive binding for reading Postgres (agent environment profiles).
   * The `connectionString` is proxied through Hyperdrive so the worker
   * authenticates against Hyperdrive, not directly against Postgres.
   */
  HYPERDRIVE: Hyperdrive;
};

export type ValidatedSessionAccess = AccessibleCloudAgentSession & {
  kiloUserId: string;
  cloudAgentSessionId: string;
};

/** tRPC context passed to all procedures */
export type TRPCContext = {
  env: Env;
  userId: string;
  request: Request;
  authToken: string;
  botId?: string;
  validatedSessionAccess?: ValidatedSessionAccess;
};

export type SystemSandboxUsageEvent = {
  streamEventType: 'sandbox-usage';
  availableMB: number;
  totalMB: number;
  isLow: boolean;
  timestamp: string;
  sessionId?: string;
};
