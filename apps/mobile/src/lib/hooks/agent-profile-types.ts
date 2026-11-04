import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

/**
 * The tRPC output shapes the profile screens and hooks share. Kept in their own
 * module so the query hooks and the mutation hook can both depend on them
 * without importing each other.
 */
type RouterOutputs = inferRouterOutputs<MobileRouter>;

/** A profile summary as the list surfaces render it. Org summaries add `ownerType`. */
export type AgentProfileListItem = RouterOutputs['agentProfiles']['list'][number] & {
  ownerType?: 'organization' | 'user';
};

export type AgentProfileListCombined = RouterOutputs['agentProfiles']['listCombined'];
export type AgentProfileDetail = RouterOutputs['agentProfiles']['get'];
/** One MCP server row, as the section read returns it. */
export type AgentProfileMcpServerRow = RouterOutputs['agentProfiles']['mcpServers'][number];
/** One slash-command row, as the section read returns it. */
export type AgentProfileKiloCommandRow = RouterOutputs['agentProfiles']['kiloCommands'][number];
/** One skill row, as the section read returns it. */
export type AgentProfileSkillRow = RouterOutputs['agentProfiles']['skills'][number];
/** One profile's metadata and collection counts, as the Overview renders them. */
export type AgentProfileOverview = RouterOutputs['agentProfiles']['overview'];

/** One repo-to-profile binding as `listRepoBindings` returns it. */
export type AgentRepoBinding = RouterOutputs['agentProfiles']['listRepoBindings'][number];
