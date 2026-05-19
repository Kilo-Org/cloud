// Types
export type {
  ProfileOwner,
  ProfileOwnerType,
  ProfileVarResponse,
  ProfileCommandResponse,
  ProfileMcpServerResponse,
  McpServerConfigFragment,
  ProfileSkillResponse,
  ProfileAgentResponse,
  ProfileKiloCommandResponse,
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
  getProfileByName,
  getProfileIdByName,
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
  parseSkillFrontmatter,
  listSkillsForProfile,
  createCustomSkill,
  updateSkill,
  deleteSkill,
  setSkillEnabled,
  getSkillsForSession,
  type SkillCustomInput,
  type SkillUpdateInput,
  type SkillForSession,
} from './profile-skills-service';

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

// Repo binding CRUD
export {
  bindProfileToRepo,
  unbindRepo,
  getBindingForRepo,
  listBindings,
} from './repo-binding-service';
