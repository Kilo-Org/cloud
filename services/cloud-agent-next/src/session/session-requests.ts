import type { CallbackTarget } from '../callbacks/index.js';
import type { AgentSelection, PromptSubmission, SessionFinalization } from '../execution/types.js';
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
      token?: string;
      branch?: string;
    }
  | {
      type: 'gitlab';
      url: string;
      token?: string;
      branch?: string;
    }
  | {
      type: 'git';
      url: string;
      token?: string;
      platform?: 'github' | 'gitlab';
      branch?: string;
    };

export type SessionCreateRequest = {
  initialPrompt: PromptSubmission;
  agent: AgentSelection;
  repository: SessionRepositoryRequest;
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
  };
};
