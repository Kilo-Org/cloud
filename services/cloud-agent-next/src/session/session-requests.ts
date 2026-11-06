import type { SandboxAllocation } from '@kilocode/worker-utils/sandbox-allocation';
import type { EgressMode } from '@kilocode/worker-utils/egress-allowlist';
import type { CallbackTarget } from '../callbacks/index.js';
import type {
  AgentSelection,
  ExecutionTurnSubmission,
  SessionFinalization,
} from '../execution/types.js';
import type { SessionProfileBundle } from '../session-profile.js';
import type { EnvironmentScope } from '../environment-build/reference.js';
import type { EnvironmentSetupBinding } from '../shared/environment-setup.js';

export type ProfileOverrides = {
  envVars?: Record<string, string>;
  encryptedSecrets?: SessionProfileBundle['encryptedSecrets'];
  setupCommands?: string[];
  mcpServers?: SessionProfileBundle['mcpServers'];
  runtimeSkills?: SessionProfileBundle['runtimeSkills'];
  runtimeAgents?: SessionProfileBundle['runtimeAgents'];
  appendSystemPrompt?: string;
};

export type SessionRepositoryRequest =
  | {
      type: 'github';
      repo: string;
      githubIntegrationId?: string;
      githubAccessPurpose?: 'workflow' | 'agent';
      allowUserAuthorization?: boolean;
      pullRequestNumber?: number;
      branch?: string;
    }
  | {
      type: 'gitlab';
      url: string;
      branch?: string;
    }
  | {
      type: 'bitbucket';
      url: string;
      workspaceUuid: string;
      repositoryUuid: string;
      bitbucketIntegrationId?: string;
      branch?: string;
    }
  | {
      type: 'git';
      url: string;
      token?: string;
      branch?: string;
    };

export type SessionRuntimeIntent = {
  sandboxAllocation?: SandboxAllocation;
  egressMode?: EgressMode;
  egressAllowlist?: string[];
  egressAudit?: boolean;
};

export type SessionCreateRequest = {
  parentCloudAgentSessionId?: string;
  /** Omitted for a clone-only create: the copied transcript is the session state. */
  initialTurn?: ExecutionTurnSubmission;
  agent: AgentSelection;
  repository: SessionRepositoryRequest;
  runtime?: SessionRuntimeIntent;
  /**
   * The allocation that the owner's saved settings resolved for this create,
   * set only by the Worker and never by a client. `null` means the settings were
   * read and none applied, so a retry does not read them again.
   */
  savedSandboxAllocation?: SandboxAllocation | null;
  clone?: {
    cloneFromKiloSessionId: string;
    /** Inclusive cut: copy source messages up to and including this ID. */
    cloneUpToMessageId?: string;
  };
  /**
   * Server-only title for the ingest ownership row (`cli_sessions_v2.title`),
   * set only by the continuation handler from the source session's title.
   * Defaults to the generated `New session - <date>` for every other create.
   */
  ownershipTitle?: string;
  /**
   * The environment the client selected, copied raw from the request. The client
   * cannot supply a resolved environment; preflight resolves `id` against the
   * owner and the launch repository, and checks that each of `repositories` is an
   * additional member of it. `repositories` carries the branch of an additional
   * repository; the launch repository's branch is `repository.branch`.
   */
  requestedEnvironment?: {
    id: string;
    repositories?: { repoFullName: string; branch?: string }[];
  };
  /**
   * The environment setup run this session prepares, trusted only on a
   * non-authority internal-key `prepareSession`. Preflight verifies it against
   * the database and turns it into `environmentSetup`.
   */
  environmentSetupRunId?: string;
  /** The setup run whose verification this session serves, copied raw from the request. */
  verificationOf?: { runId: string };
  /**
   * Set only by preflight. It binds the session to one environment setup run
   * and role; the client can never set it.
   */
  environmentSetup?: EnvironmentSetupBinding;
  /**
   * Set only by a client that can ask its user to choose an environment. When
   * several environments contain the repository and `requestedEnvironment` names
   * none, preflight then fails with a conflict that names them. Without it, the
   * session runs with no environment.
   */
  requireEnvironmentChoice?: true;
  /**
   * The authorized scope of the repository's environment, set only by preflight
   * after it resolved the environment from the owner and the repository.
   * Session registration adds the branch of each V2 repository and persists the
   * result on session metadata, which carries it DO-private to the Sandbox DO
   * for snapshot selection.
   */
  environment?: EnvironmentScope;
  /**
   * The environment's saved allocation key, set only by preflight and never by
   * a client. It is the first saved candidate; eligibility is checked when the
   * saved allocation is resolved.
   */
  environmentSandboxAllocation?: string;
  profile?: {
    id?: string;
    overrides?: ProfileOverrides;
    resolved?: SessionProfileBundle;
    /**
     * The active profile id after server-side resolution, set by
     * `applyProfileResolution`. Distinguished from `id` (the client's
     * requested pick) because a repository binding or the effective default
     * can decide the session's profile. Persisted on `cli_sessions_v2`.
     */
    resolvedProfileId?: string;
  };
  finalization?: SessionFinalization;
  options?: {
    callbackTarget?: CallbackTarget;
    kilocodeOrganizationId?: string;
    createdOnPlatform?: string;
    clientProvenance?: 'browser' | 'mobile' | 'agent-manager';
    shallow?: boolean;
    /** Stable per-user-intent UUID; the handler admits it only with `autoInitiate` true. */
    operationKey?: string;
    /**
     * Server-only marker for a `continueHostedWorkspace` create. It persists on
     * session metadata and makes the wrapper skip transcript file restoration.
     * Never set from a client input field.
     */
    workspaceContinuation?: boolean;
    /** Client-proposed Kilo session ID; the Worker generates one when absent. */
    kiloSessionId?: string;
  };
};
