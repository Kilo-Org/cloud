// Types
export type {
  ProfileOwner,
  ProfileOwnerType,
  ProfileDatabase,
  RepositoryPlatform,
  ProfileVarResponse,
  ProfileCommandResponse,
  ProfileMcpServerResponse,
  McpServerConfigFragment,
  ProfileSkillResponse,
  ProfileAgentResponse,
  ProfileKiloCommandResponse,
  ProfileInstructionResponse,
  ProfileResponse,
  ProfileResponseWithOwner,
  ProfileSummary,
  ProfileSummaryWithOwner,
  CombinedProfilesResult,
} from './types';
export { MASKED_SECRET_VALUE } from './types';

// Pure resolution helpers
export {
  resolveProfileLayers,
  type ProfileLayer,
  type ProfileLayerSource,
  type ResolvedProfileLayers,
  type ResolveProfileLayersInput,
} from './profile-resolution';

// Session-config merge (main entry point for callers)
export {
  mergeProfileConfiguration,
  profileMcpServersToClientRecord,
  ProfileNotFoundError,
  type MergeProfileConfigurationArgs,
  type MergeProfileConfigurationResult,
  type MergedSkillForSession,
  type MergedAgentForSession,
  type MergedKiloCommandForSession,
  type MergedInstructionForSession,
  type ClientMcpServerValue,
  type InlineSkillInput,
  type InlineAgentInput,
} from './profile-session-config';

// Utilities
export { buildOwnershipCondition, verifyProfileOwnership } from './profile-utils';

// Profile CRUD + lookups
export {
  createProfile,
  updateProfile,
  deleteProfile,
  listProfiles,
  getProfile,
  setDefaultProfile,
  clearDefaultProfile,
  getDefaultProfile,
  getEffectiveDefaultProfileId,
} from './profile-service';

// Var CRUD
export {
  setVar,
  deleteVar,
  listVars,
  getVarsForSession,
  setVars,
  type VarForSession,
} from './profile-vars-service';

// Command CRUD
export { setCommands, listCommands, getCommandsForSession } from './profile-commands-service';

// MCP server CRUD + session helpers
export {
  MAX_PROFILE_MCP_SERVERS,
  MAX_MCP_SERVER_NAME_LENGTH,
  MAX_MCP_ENV_OR_HEADERS,
  mcpLocalConfigInputSchema,
  mcpRemoteConfigInputSchema,
  mcpLocalServerInputSchema,
  mcpRemoteServerInputSchema,
  mcpServerFullInputSchema,
  listMcpServersForProfile,
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
  setMcpEnabled,
  getMcpServersForSession,
  type McpServerInput,
  type McpServerForSession,
} from './profile-mcp-service';

// Skill CRUD + session helpers
export {
  MAX_PROFILE_SKILLS,
  MAX_SKILL_NAME_LENGTH,
  MAX_SKILL_MARKDOWN_LENGTH,
  MAX_SKILL_DESCRIPTION_LENGTH,
  MAX_SKILL_COMPANION_FILES,
  MAX_SKILL_COMPANION_FILE_SIZE,
  MAX_SKILL_COMPANION_FILES_TOTAL,
  MAX_SKILL_COMPANION_PATH_LENGTH,
  skillNameSchema,
  skillFilesSchema,
  skillCustomInputSchema,
  skillUpdateInputSchema,
  skillsShInputSchema,
  parseSkillFrontmatter,
  listSkillsForProfile,
  createCustomSkill,
  createSkillsShSkill,
  updateSkill,
  deleteSkill,
  setSkillEnabled,
  getSkillsForSession,
  type SkillCustomInput,
  type SkillUpdateInput,
  type SkillsShInput,
  type SkillForSession,
} from './profile-skills-service';

export type { SkillsShSource } from './skills-sh';

// Agent CRUD + session helpers
export {
  MAX_PROFILE_AGENTS,
  MAX_AGENT_NAME_LENGTH,
  MAX_AGENT_SLUG_LENGTH,
  BUILTIN_AGENT_SLUGS,
  agentSlugSchema,
  agentNameSchema,
  agentCreateInputSchema,
  agentUpdateInputSchema,
  listAgentsForProfile,
  createAgent,
  updateAgent,
  deleteAgent,
  getAgentsForSession,
  type AgentCreateInput,
  type AgentUpdateInput,
  type AgentForSession,
} from './profile-agents-service';

// Kilo command CRUD + session helpers
export {
  MAX_PROFILE_KILO_COMMANDS,
  MAX_KILO_COMMAND_NAME_LENGTH,
  MAX_KILO_COMMAND_TEMPLATE_LENGTH,
  MAX_KILO_COMMAND_DESCRIPTION_LENGTH,
  BUILTIN_COMMAND_NAMES,
  kiloCommandNameSchema,
  kiloCommandCreateInputSchema,
  kiloCommandUpdateInputSchema,
  listKiloCommandsForProfile,
  createKiloCommand,
  updateKiloCommand,
  deleteKiloCommand,
  setKiloCommandEnabled,
  reorderKiloCommands,
  getKiloCommandsForSession,
  type KiloCommandCreateInput,
  type KiloCommandUpdateInput,
  type KiloCommandForSession,
} from './profile-kilo-commands-service';

// Instruction CRUD + session helpers
export {
  MAX_PROFILE_INSTRUCTIONS,
  instructionCreateInputSchema,
  instructionUpdateInputSchema,
  listInstructionsForProfile,
  createInstruction,
  updateInstruction,
  deleteInstruction,
  setInstructionEnabled,
  getInstructionsForSession,
  type InstructionCreateInput,
  type InstructionUpdateInput,
  type InstructionForSession,
} from './profile-instructions-service';

// Repo binding CRUD
export {
  bindProfileToRepo,
  unbindRepo,
  removeRepoBinding,
  getBindingForRepo,
  listBindings,
} from './repo-binding-service';
export { canonicalRepoFullName } from './repo-binding-db';

// Combined repository settings (profile binding + allocation override)
export {
  setRepositorySettings,
  removeRepositorySettings,
  type RepositorySettingsInput,
} from './repository-settings-service';

// Sandbox allocation settings (context default + per-repository overrides)
export {
  getSandboxAllocationSettings,
  getSandboxAllocationCandidates,
  setContextSandboxAllocation,
  clearContextSandboxAllocation,
  setRepoSandboxAllocation,
  clearRepoSandboxAllocation,
  type SandboxAllocationSettings,
  type SandboxAllocationCandidates,
  type RepositoryAllocationSetting,
} from './sandbox-allocation-settings-service';

// Local config import (preview diff + selective upsert)
export {
  buildImportPreview,
  applyImport,
  type ConfigImportPreview,
  type ImportCategoryPreview,
  type ImportChangedItem,
  type ImportFieldChange,
  type PostImportAgent,
  type PostImportInstruction,
  type PostImportKiloCommand,
  type PostImportSkill,
} from './profile-import-service';
