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
  initialTurn: ExecutionTurnSubmission;
  agent: AgentSelection;
  repository: SessionRepositoryRequest;
  runtime?: SessionRuntimeIntent;
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
    /**
     * Client-generated UUID, stable across retries of one user intent. The
     * handler admits the create into the operation ledger only when this is
     * present AND the effective `autoInitiate` is true; otherwise the key is
     * ignored and the legacy split-flow behavior is preserved.
     */
    operationKey?: string;
  };
};
