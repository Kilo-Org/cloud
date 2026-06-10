import type { AgentConfig } from '@kilocode/db/schema-types';

/** Owner type for agent environment profiles - exactly one of organizationId or userId must be set. */
export type ProfileOwner = { type: 'organization'; id: string } | { type: 'user'; id: string };

/** Owner type discriminator for UI display. */
export type ProfileOwnerType = ProfileOwner['type'];

/** Profile variable response type (for API responses). Secret values are masked. */
export type ProfileVarResponse = {
  key: string;
  value: string; // Masked as '***' for secrets
  isSecret: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Profile command response type. */
export type ProfileCommandResponse = {
  sequence: number;
  command: string;
};

/**
 * Sanitized representation of an MCP server on a profile. Secret env/header
 * values are masked as the placeholder string `"••••"` so the UI can show
 * key names and count without ever exposing plaintext or ciphertext to the
 * browser.
 */
export type ProfileMcpServerResponse = {
  id: string;
  name: string;
  type: 'local' | 'remote';
  enabled: boolean;
  timeout: number | null;
  /** CLI-native config with env/header values masked. */
  config: McpServerConfigFragment;
  createdAt: string;
  updatedAt: string;
};

/**
 * CLI-native MCP config fragment with env/header values always as strings.
 * On GET responses the strings are the masked placeholder; in request inputs
 * they are the plaintext value the caller wants encrypted at-rest.
 */
export type McpServerConfigFragment =
  | {
      command: string[];
      environment?: Record<string, string>;
    }
  | {
      url: string;
      headers?: Record<string, string>;
    };

/** Placeholder returned in place of encrypted env/header values on GET responses. */
export const MASKED_SECRET_VALUE = '\u2022\u2022\u2022\u2022';

/** Skill response (as returned from the API). Includes raw markdown since the markdown *is* the artifact. */
export type ProfileSkillResponse = {
  id: string;
  name: string;
  description: string | null;
  sourceType: 'marketplace' | 'custom';
  sourceUrl: string | null;
  rawMarkdown: string;
  /** Companion files (excluding SKILL.md). Relative path → content. */
  files: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Agent response (as returned from the API). Mirrors the kilocode CLI's AgentConfig shape. */
export type ProfileAgentResponse = {
  id: string;
  slug: string;
  name: string;
  config: AgentConfig;
  createdAt: string;
  updatedAt: string;
};

/** Profile kilo command response type. */
export type ProfileKiloCommandResponse = {
  id: string;
  name: string;
  description: string | null;
  template: string;
  agent: string | null;
  model: string | null;
  subtask: boolean;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

/** Profile response type for list/get operations. */
export type ProfileResponse = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  vars: ProfileVarResponse[];
  commands: ProfileCommandResponse[];
  mcpServers: ProfileMcpServerResponse[];
  skills: ProfileSkillResponse[];
  agents: ProfileAgentResponse[];
  kiloCommands: ProfileKiloCommandResponse[];
};

/** Profile response with owner type for combined listings. */
export type ProfileResponseWithOwner = ProfileResponse & {
  ownerType: ProfileOwnerType;
};

/** Profile summary for list operations (without vars/commands). */
export type ProfileSummary = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  varCount: number;
  commandCount: number;
  mcpServerCount: number;
  skillCount: number;
  agentCount: number;
  kiloCommandCount: number;
};

/** Profile summary with owner type for combined listings. */
export type ProfileSummaryWithOwner = ProfileSummary & {
  ownerType: ProfileOwnerType;
};

/** Combined profiles result for org context - returns both org and personal profiles with effective default. */
export type CombinedProfilesResult = {
  orgProfiles: ProfileSummaryWithOwner[];
  personalProfiles: ProfileSummaryWithOwner[];
  effectiveDefaultId: string | null;
};
