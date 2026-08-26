import type { CallbackTarget } from '../callbacks/index.js';
import type {
  AgentSelection,
  ExecutionTurnSubmission,
  SessionFinalization,
} from '../execution/types.js';
import type { SessionProfileBundle } from '../session-profile.js';

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
  devcontainer?: boolean;
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
