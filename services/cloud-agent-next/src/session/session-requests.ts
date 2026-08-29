import type { CallbackTarget } from '../callbacks/index.js';
import type {
  AgentSelection,
  ExecutionTurnSubmission,
  SessionFinalization,
} from '../execution/types.js';
import type { SessionProfileBundle } from '../session-profile.js';
import type { Owner } from '../types.js';

export type ProfileOverrides = {
  envVars?: Record<string, string>;
  encryptedSecrets?: SessionProfileBundle['encryptedSecrets'];
  setupCommands?: string[];
  mcpServers?: SessionProfileBundle['mcpServers'];
  runtimeSkills?: SessionProfileBundle['runtimeSkills'];
  runtimeAgents?: SessionProfileBundle['runtimeAgents'];
  appendSystemPrompt?: string;
};

export type ResolvedRepositoryIdentity = {
  kind: 'resolved';
  integrationId: string;
  integrationOwner: Owner;
  instanceUrl: string;
};

export type RepositoryIdentityResolution =
  | ResolvedRepositoryIdentity
  | { kind: 'legacy-unresolved' };

export function normalizeRepositoryIdentity(repository: {
  resolvedIdentity?: ResolvedRepositoryIdentity;
}): RepositoryIdentityResolution {
  // Old requests and records lack authorized identity. Remove this fallback only
  // after old clients/records disappear and the 30-day ledger window expires.
  return repository.resolvedIdentity ?? { kind: 'legacy-unresolved' };
}

export type SessionRepositoryRequest = (
  | {
      type: 'github';
      repo: string;
      githubIntegrationId?: string;
      branch?: string;
    }
  | {
      type: 'gitlab';
      url: string;
      gitlabIntegrationId?: string;
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
    }
) & { resolvedIdentity?: ResolvedRepositoryIdentity };

export type SessionRuntimeIntent = {
  devcontainer?: boolean;
  sandboxAllocation?: 'isolated-standard';
};

export type SessionCreateRequest = {
  /** Omitted for a clone-only create: the copied transcript is the session state. */
  initialTurn?: ExecutionTurnSubmission;
  agent: AgentSelection;
  repository: SessionRepositoryRequest;
  runtime?: SessionRuntimeIntent;
  clone?: {
    cloneFromKiloSessionId: string;
  };
  profile?: {
    id?: string;
    overrides?: ProfileOverrides;
    resolved?: SessionProfileBundle;
  };
  finalization?: SessionFinalization;
  options?: {
    callbackTarget?: CallbackTarget;
    kilocodeOrganizationId?: string;
    createdOnPlatform?: string;
    shallow?: boolean;
    /** Stable per-user-intent UUID; the handler admits it only with `autoInitiate` true. */
    operationKey?: string;
  };
};
